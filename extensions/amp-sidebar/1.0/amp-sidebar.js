/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ActionTrust} from '../../../src/action-constants';
import {CSS} from '../../../build/amp-sidebar-1.0.css';
import {Direction, Orientation, SwipeToDismiss} from './swipe-to-dismiss';
import {Gestures} from '../../../src/gesture';
import {Services} from '../../../src/services';
import {SwipeDef, SwipeXRecognizer} from '../../../src/gesture-recognizers';

import {createCustomEvent} from '../../../src/event-helper';
import {descendsFromStory} from '../../../src/utils/story';
import {dev} from '../../../src/log';
import {dict} from '../../../src/utils/object';
import {handleAutoscroll} from './autoscroll';
import {htmlFor} from '../../../src/static-template';
import {isRTL, tryFocus} from '../../../src/dom';
import {setImportantStyles, toggle} from '../../../src/style';
import {toArray} from '../../../src/types';

/** @private @const {string} */
const TAG = 'amp-sidebar toolbar';

/** @private @const {number} */
const ANIMATION_TIMEOUT = 1000;

/** @private @enum {string} */
const Side = {
  LEFT: 'left',
  RIGHT: 'right',
};

/**  @enum {string} */
const SidebarEvents = {
  OPEN: 'sidebarOpen',
  CLOSE: 'sidebarClose',
};

/**
 * @extends {AMP.BaseElement}
 */
export class AmpSidebar extends AMP.BaseElement {
  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {?../../../src/service/viewport/viewport-interface.ViewportInterface} */
    this.viewport_ = null;

    /** @private {?../../../src/service/action-impl.ActionService} */
    this.action_ = null;

    /** @private {?function()} */
    this.updateFn_ = null;

    /** @private {?Element} */
    this.maskElement_ = null;

    /** @private @const {!Document} */
    this.document_ = this.win.document;

    /** @private {?string} */
    this.side_ = null;

    const platform = Services.platformFor(this.win);

    /** @private @const {boolean} */
    this.isIos_ = platform.isIos();

    /** @private {!Element} */
    this.notifyElements_ = null;

    /** @private @const {boolean} */
    this.isSafari_ = platform.isSafari();

    /** @private {number} */
    this.historyId_ = -1;

    /** @private {?Element} */
    this.openerElement_ = null;

    /** @private {number} */
    this.initialScrollTop_ = 0;

    /** @private {boolean} */
    this.opened_ = false;

    /** @private @const */
    this.swipeToDismiss_ = new SwipeToDismiss(
      this.win,
      cb => this.mutateElement(cb),
      // The sidebar is already animated by swipe to dismiss, so skip animation.
      () => this.dismiss_(true)
    );
  }

  /** @override */
  buildCallback() {
    const {element} = this;

    const html = htmlFor(this.element);
    this.containerElement_ = html`
      <div class="i-amphtml-sidebar-container">
        <div class="i-amphtml-sidebar-content"></div>
      </div>
    `;

    this.contentElement_ = this.containerElement_.querySelector(
      '.i-amphtml-sidebar-content'
    );

    // element.classList.add('i-amphtml-overlay');
    // element.classList.add('i-amphtml-scrollable');

    const side = element.getAttribute('side');

    this.getRealChildNodes().forEach(child => {
      this.contentElement_.appendChild(child);
    });

    this.element.appendChild(this.containerElement_);

    this.isRight_ = (side == Side.RIGHT) != isRTL(this.document_);

    this.contentElement_.setAttribute('side', this.isRight_ ? 'right' : 'left');

    // this.mainElement_ = this.getAmpDoc()
    //   .getBody()
    //   .getElementsByTagName('main')[0];

    this.viewport_ = this.getViewport();

    this.action_ = Services.actionServiceForDoc(element);

    this.registerDefaultAction(invocation => this.open_(invocation), 'open');
    this.registerAction('toggle', this.toggle_.bind(this));
    this.registerAction('close', this.close_.bind(this));

    this.setupGestures_(this.element);
  }

  /**
   * Toggles the open/close state of the sidebar.
   * @param {?../../../src/service/action-impl.ActionInvocation=} opt_invocation
   * @private
   */
  toggle_(opt_invocation) {
    if (this.opened_) {
      this.close_();
    } else {
      this.open_(opt_invocation);
    }
  }

  /**
   * Sets a function to update the state of the sidebar. If another one has
   * been set before the function takes effect, it is ignored.
   * @param {function()} updateFn A function to update the sidebar.
   * @param {number=} delay An optional delay to wait before calling the update
   *    function.
   */
  setUpdateFn_(updateFn, delay) {
    this.updateFn_ = updateFn;

    const runUpdate = () => {
      // Make sure we haven't been replaced by another update function.
      if (this.updateFn_ === updateFn) {
        this.mutateElement(updateFn);
      }
    };

    if (delay) {
      Services.timerFor(this.win).delay(runUpdate, delay);
    } else {
      runUpdate();
    }
  }

  /**
   *
   */
  updateForPreopen_() {
    this.notifyElements_.forEach(element => {
      element.setAttribute('i-amphtml-sidebar-state', 'preopen');
    });
    this.setUpdateFn_(() => this.updateForOpening_());
  }

  /**
   * Updates the sidebar while it is animating to the opened state.
   */
  updateForOpening_() {
    toggle(this.element, /* display */ true);
    this.viewport_.addToFixedLayer(this.element, /* forceTransfer */ true);

    this.element./*OK*/ scrollTop = 1;
    this.openMask_();
    this.element.setAttribute('open', '');
    this.notifyElements_.forEach(element => {
      element.setAttribute('i-amphtml-sidebar-state', 'opening');
      setImportantStyles(element, {
        '--amp-sidebar-width': `${this.contentElement_.offsetWidth}px`,
      });
    });
    this.setUpdateFn_(() => this.updateForOpened_(), ANIMATION_TIMEOUT);
    handleAutoscroll(this.getAmpDoc(), this.element);
  }

  /**
   * Updates the sidebar for when it has finished opening.
   */
  updateForOpened_() {
    // On open sidebar
    const children = toArray(this.contentElement_.children);
    const owners = Services.ownersForDoc(this.element);
    owners.scheduleLayout(this.element, children);
    owners.scheduleResume(this.element, children);
    this.notifyElements_.forEach(element => {
      element.setAttribute('i-amphtml-sidebar-state', 'opened');
    });

    this.triggerEvent_(SidebarEvents.OPEN);
  }

  /**
   * Updates the sidebar for when it is animating to the closed state.
   */
  updateForClosing_() {
    this.element.removeAttribute('open');
    this.notifyElements_.forEach(element => {
      element.setAttribute('i-amphtml-sidebar-state', 'closing');
    });
    this.setUpdateFn_(() => this.updateForClosed_(), ANIMATION_TIMEOUT);
  }

  /**
   * Updates the sidebar for when it has finished closing.
   */
  updateForClosed_() {
    this.closeMask_();
    toggle(this.element, /* display */ false);
    this.notifyElements_.forEach(element => {
      element.setAttribute('i-amphtml-sidebar-state', 'closed');
    });
    Services.ownersForDoc(this.element).schedulePause(
      this.element,
      this.getRealChildren()
    );
    this.triggerEvent_(SidebarEvents.CLOSE);
  }

  /**
   * Reveals the sidebar.
   * @param {?../../../src/service/action-impl.ActionInvocation=} opt_invocation
   * @private
   */
  open_(opt_invocation) {
    if (this.opened_) {
      return;
    }
    this.opened_ = true;
    this.notifyElements_ = toArray(
      this.getAmpDoc()
        .getRootNode()
        .querySelectorAll(this.element.getAttribute('notify-selector'))
    ).concat([
      this.contentElement_,
      this.containerElement_,
      this.getMaskElement_(),
    ]);
    this.notifyElements_.forEach(element => {
      element.setAttribute(
        'open-style',
        this.element.getAttribute('open-style')
      );
      element.setAttribute('side', this.element.getAttribute('side'));
    });

    this.viewport_.enterOverlayMode();
    this.setUpdateFn_(() => this.updateForPreopen_());
    this.getHistory_()
      .push(this.close_.bind(this))
      .then(historyId => {
        this.historyId_ = historyId;
      });
    if (opt_invocation) {
      this.openerElement_ = opt_invocation.caller;
      this.initialScrollTop_ = this.viewport_.getScrollTop();
    }
  }

  /**
   * Hides the sidebar.
   * @return {boolean} Whether the sidebar actually transitioned from "visible"
   *     to "hidden".
   * @private
   */
  close_() {
    this.dismiss_(false);
  }

  /**
   * Dismisses the sidebar.
   * @param {boolean} immediate Whether sidebar should close immediately,
   *     without animation.
   * @return {boolean} Whether the sidebar actually transitioned from "visible"
   *     to "hidden".
   * @private
   */
  dismiss_(immediate) {
    if (!this.opened_) {
      return false;
    }
    this.opened_ = false;
    this.viewport_.leaveOverlayMode();
    const scrollDidNotChange =
      this.initialScrollTop_ == this.viewport_.getScrollTop();
    const sidebarIsActive = this.element.contains(this.document_.activeElement);
    this.setUpdateFn_(() => this.updateForClosing_(immediate));
    // Immediately hide the sidebar so that animation does not play.
    if (immediate) {
      this.closeMask_();
      toggle(this.element, /* display */ false);
      this.notifyElements_.forEach(element => {
        element.setAttribute('i-amphtml-sidebar-state', 'closed');
      });
    }
    if (this.historyId_ != -1) {
      this.getHistory_().pop(this.historyId_);
      this.historyId_ = -1;
    }
    if (this.openerElement_ && sidebarIsActive && scrollDidNotChange) {
      // As of iOS 12.2, focus() causes undesired scrolling in UIWebViews.
      if (!this.isIosWebView_()) {
        tryFocus(this.openerElement_);
      }
    }
    return true;
  }

  /**
   * Set up gestures for the specified element.
   * @param {!Element} element
   * @private
   */
  setupGestures_(element) {
    // if (!isExperimentOn(this.win, 'amp-sidebar-swipe-to-dismiss')) {
    //   return;
    // }
    // stop propagation of swipe event inside amp-viewer
    const gestures = Gestures.get(
      dev().assertElement(element),
      /* shouldNotPreventDefault */ false,
      /* shouldStopPropagation */ true
    );
    gestures.onGesture(SwipeXRecognizer, ({data}) => {
      this.handleSwipe_(data);
    });
  }

  /**
   * Handles a swipe gesture, updating the current swipe to dismiss state.
   * @param {!SwipeDef} data
   */
  handleSwipe_(data) {
    if (data.first) {
      this.swipeToDismiss_.startSwipe({
        swipeElements: this.notifyElements_,
        direction: this.isRight_ ? Direction.FORWARD : Direction.BACKWARD,
        orientation: Orientation.HORIZONTAL,
      });
      return;
    }

    if (data.last) {
      this.swipeToDismiss_.endSwipe(data);
      return;
    }

    this.swipeToDismiss_.swipeMove(data);
  }

  /**
   * Sidebars within <amp-story> should be 'flipped'.
   * @param {!Side} side
   * @return {Side}
   * @private
   */
  setSideAttribute_(side) {
    if (!descendsFromStory(this.element)) {
      return side;
    } else {
      return side == Side.LEFT ? Side.RIGHT : Side.LEFT;
    }
  }

  /**
   * Get the sidebar's mask element; create one if none exists.
   * @return {!Element}
   * @private
   */
  getMaskElement_() {
    if (!this.maskElement_) {
      const mask = this.document_.createElement('div');
      mask.classList.add('i-amphtml-sidebar-mask');
      mask.addEventListener('click', () => {
        this.close_();
      });
      this.getAmpDoc()
        .getBody()
        .appendChild(mask);
      mask.addEventListener('touchmove', e => {
        e.preventDefault();
      });
      this.setupGestures_(mask);
      this.maskElement_ = mask;
    }
    return this.maskElement_;
  }

  /**
   * @private
   */
  openMask_() {
    this.getMaskElement_().classList.toggle('i-amphtml-ghost', false);
  }

  /**
   * @private
   */
  closeMask_() {
    if (this.maskElement_) {
      this.maskElement_.classList.toggle('i-amphtml-ghost', true);
    }
  }

  /**
   * @private
   * @return {!../../../src/service/history-impl.History}
   */
  getHistory_() {
    return Services.historyForDoc(this.getAmpDoc());
  }

  /**
   * @param {string} name
   * @private
   */
  triggerEvent_(name) {
    const event = createCustomEvent(this.win, `${TAG}.${name}`, dict({}));
    this.action_.trigger(this.element, name, event, ActionTrust.HIGH);
  }

  /**
   * @return {boolean}
   * @private
   */
  isIosWebView_() {
    // Don't use isWebviewEmbedded() because it assumes there's no parent
    // iframe, but this is not necessarily true for all UIWebView embeds.
    return this.isIos_ && Services.viewerForDoc(this.element).isEmbedded();
  }
}

AMP.extension('amp-sidebar', '0.1', AMP => {
  AMP.registerElement('amp-sidebar', AmpSidebar, CSS);
});
