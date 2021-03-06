/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2010-2017
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 Infocatcher <https://github.com/Infocatcher>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ******/
'use strict';


import RichConfirm from '../extlib/RichConfirm.js';

import {
  log,
  wait,
  configs
} from '../common/common.js';
import * as Constants from '../common/constants.js';
import * as Tabs from '../common/tabs.js';
import * as TabsOpen from '../common/tabs-open.js';
import * as Tree from '../common/tree.js';
import * as TSTAPI from '../common/tst-api.js';
import * as Scroll from './scroll.js';
import * as EventUtils from './event-utils.js';
import * as SidebarTabs from './sidebar-tabs.js';


const kTREE_DROP_TYPE   = 'application/x-treestyletab-tree';
const kTYPE_X_MOZ_PLACE = 'text/x-moz-place';
const kBOOKMARK_FOLDER = 'x-moz-place:';

let gLongHoverExpandedTabs = [];
let gLongHoverTimer;
let gLongHoverTimerNext;

let gDelayedDragEnter;
let gDelayedDragLeave;

let gDraggingOnSelfWindow = false;

let gCapturingForDragging = false;
let gReadyToCaptureMouseEvents = false;
let gLastDragEnteredTarget = null;
let gLastDropPosition      = null;
let gDragTargetIsClosebox  = false;
let gCurrentDragData       = null;

export function startListen() {
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
}

export function endListen() {
  document.removeEventListener('dragstart', onDragStart);
  document.removeEventListener('dragover', onDragOver);
  document.removeEventListener('dragenter', onDragEnter);
  document.removeEventListener('dragleave', onDragLeave);
  document.removeEventListener('drop', onDrop);
}


export function isCapturingForDragging() {
  return gCapturingForDragging;
}

export function startMultiDrag(aTab, aIsClosebox) {
  TSTAPI.sendMessage({
    type:   TSTAPI.kNOTIFY_TAB_DRAGREADY,
    tab:    TSTAPI.serializeTab(aTab),
    window: Tabs.getWindow(),
    startOnClosebox: aIsClosebox
  });
  gReadyToCaptureMouseEvents = true;
}

export function endMultiDrag(aTab, aCoordinates) {
  const serializedTab = aTab && TSTAPI.serializeTab(aTab);
  if (gCapturingForDragging) {
    window.removeEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.removeEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.releaseCapture();

    TSTAPI.sendMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGEND,
      tab:     serializedTab,
      window:  aTab && aTab.apiTab.windowId,
      clientX: aCoordinates.clientX,
      clientY: aCoordinates.clientY
    });

    gLastDragEnteredTarget = null;
  }
  else if (gReadyToCaptureMouseEvents) {
    TSTAPI.sendMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGCANCEL,
      tab:     serializedTab,
      window:  aTab && aTab.apiTab.windowId,
      clientX: aCoordinates.clientX,
      clientY: aCoordinates.clientY
    });
  }
  gCapturingForDragging = false;
  gReadyToCaptureMouseEvents = false;
}

export function setDragData(aDragData) {
  return gCurrentDragData = aDragData;
}


/* helpers */

function getDragDataFromOneTab(aTab, aOptions = {}) {
  aTab = Tabs.getTabFromChild(aTab);
  if (!aTab)
    return {
      tabNode:  null,
      tabNodes: [],
      apiTab:   null,
      apiTabs:  [],
      windowId: null
    };

  const draggedTabs = aOptions.shouldIgnoreDescendants ? [aTab] : getDraggedTabsFromOneTab(aTab);
  return {
    tabNode:  aTab,
    tabNodes: draggedTabs,
    apiTab:   aTab.apiTab,
    apiTabs:  draggedTabs.map(aDraggedTab => aDraggedTab.apiTab),
    windowId: aTab.apiTab.windowId
  };
}

function getDraggedTabsFromOneTab(aTab) {
  if (Tabs.isSelected(aTab))
    return Tabs.getSelectedTabs(aTab);
  return [aTab].concat(Tabs.getDescendantTabs(aTab));
}

function sanitizeDragData(aDragData) {
  return {
    tabNode:  null,
    tabNodes: [],
    apiTab:   aDragData.apiTab,
    apiTabs:  aDragData.apiTabs,
    windowId: aDragData.windowId
  };
}

function getDropAction(aEvent) {
  const dragOverTab = EventUtils.getTabFromEvent(aEvent);
  const targetTab   = dragOverTab || EventUtils.getTabFromTabbarEvent(aEvent);
  const info = {
    dragOverTab,
    targetTab,
    dropPosition:  null,
    action:        null,
    parent:        null,
    insertBefore:  null,
    insertAfter:   null,
    defineGetter(aName, aGetter) {
      delete this[aName];
      Object.defineProperty(this, aName, {
        get() {
          delete this[aName];
          return this[aName] = aGetter.call(this);
        },
        configurable: true,
        enumerable:   true
      });
    }
  };
  info.defineGetter('dragData', () => {
    const dragData = aEvent.dataTransfer.mozGetDataAt(kTREE_DROP_TYPE, 0);
    return (dragData && JSON.parse(dragData)) || gCurrentDragData;
  });
  info.defineGetter('draggedTab', () => {
    // don't touch this if not needed, to reduce needless function call.
    return Tabs.getTabById(info.draggedAPITab);
  });
  info.defineGetter('draggedAPITab', () => {
    const dragData = info.dragData;
    return dragData && dragData.apiTab;
  });
  info.defineGetter('draggedTabs', () => {
    // don't touch this if not needed, to reduce needless function call.
    return info.draggedAPITabs.map(Tabs.getTabById).filter(aTab => !!aTab);
  });
  info.defineGetter('draggedAPITabs', () => {
    const dragData = info.dragData;
    return (dragData && dragData.apiTabs).filter(aAPITab => !!aAPITab) || [];
  });
  info.defineGetter('draggedAPITabIDs', () => {
    return info.draggedAPITabs.map(aApiTab => aApiTab.id);
  });
  info.defineGetter('targetTabs', () => {
    return Tabs.getAllTabs(targetTab);
  });
  info.defineGetter('firstTargetTab', () => {
    return Tabs.getFirstNormalTab(targetTab) || info.targetTabs[0];
  });
  info.defineGetter('lastTargetTab', () => {
    return info.targetTabs[info.targetTabs.length - 1];
  });
  info.defineGetter('canDrop', () => {
    const draggedApiTab               = info.dragData && info.dragData.apiTab;
    const isPrivateBrowsingTabDragged = draggedApiTab && draggedApiTab.incognito;
    if (draggedApiTab &&
        isPrivateBrowsingTabDragged != Tabs.isPrivateBrowsing(info.dragOverTab || Tabs.getFirstTab())) {
      return false;
    }
    else if (info.draggedAPITab) {
      if (info.dragOverTab &&
          info.draggedAPITab.pinned != Tabs.isPinned(info.dragOverTab)) {
        return false;
      }
      else if (info.action & Constants.kACTION_ATTACH) {
        if (info.parent &&
            info.parent.apiTab.id == info.draggedAPITab.id) {
          return false;
        }
        else if (info.dragOverTab) {
          if (info.draggedAPITabIDs.includes(info.dragOverTab.apiTab.id))
            return false;
          const ancestors = Tabs.getAncestorTabs(info.dragOverTab);
          /* too many function call in this way, so I use alternative way for better performance.
          return !info.draggedAPITabIDs.includes(info.dragOverTab.apiTab.id) &&
                   Tabs.collectRootTabs(info.draggedTabs).every(aRootTab =>
                     !ancestors.includes(aRootTab)
                   );
          */
          for (const apiTab of info.draggedAPITabs.slice().reverse()) {
            const tab    = Tabs.getTabById(apiTab);
            const parent = Tabs.getParentTab(tab);
            if (!parent && ancestors.includes(parent))
              return false;
          }
          return true;
        }
      }
    }

    if (info.dragOverTab &&
        (Tabs.isHidden(info.dragOverTab) ||
         (Tabs.isCollapsed(info.dragOverTab) &&
          info.dropPosition != Constants.kDROP_AFTER)))
      return false;

    return true;
  });
  info.defineGetter('EventUtils.isCopyAction', () => EventUtils.isCopyAction(aEvent));
  info.defineGetter('dropEffect', () => getDropEffectFromDropAction(info));

  if (!targetTab) {
    //log('dragging on non-tab element');
    const action = Constants.kACTION_MOVE | Constants.kACTION_DETACH;
    if (aEvent.clientY < info.firstTargetTab.getBoundingClientRect().top) {
      //log('dragging above the first tab');
      info.targetTab    = info.insertBefore = info.firstTargetTab;
      info.dropPosition = Constants.kDROP_BEFORE;
      info.action       = action;
    }
    else if (aEvent.clientY > info.lastTargetTab.getBoundingClientRect().bottom) {
      //log('dragging below the last tab');
      info.targetTab    = info.insertAfter = info.lastTargetTab;
      info.dropPosition = Constants.kDROP_AFTER;
      info.action       = action;
    }
    return info;
  }

  /**
   * Basically, tabs should have three areas for dropping of items:
   * [start][center][end], but, pinned tabs couldn't have its tree.
   * So, if a tab is dragged and the target tab is pinned, then, we
   * have to ignore the [center] area.
   */
  const onPinnedTab         = Tabs.isPinned(targetTab);
  const dropAreasCount      = (info.draggedAPITab && onPinnedTab) ? 2 : 3 ;
  const targetTabRect       = targetTab.getBoundingClientRect();
  const targetTabCoordinate = onPinnedTab ? targetTabRect.left : targetTabRect.top ;
  const targetTabSize       = onPinnedTab ? targetTabRect.width : targetTabRect.height ;
  let beforeOrAfterDropAreaSize;
  if (dropAreasCount == 2) {
    beforeOrAfterDropAreaSize = Math.round(targetTabSize / dropAreasCount);
  }
  else { // enlarge the area to dop something on the tab itself
    beforeOrAfterDropAreaSize = Math.round(targetTabSize / 4);
  }
  const eventCoordinate = onPinnedTab ? aEvent.clientX : aEvent.clientY;
  //log('coordinates: ', {
  //  event: eventCoordinate,
  //  targetTab: targetTabCoordinate,
  //  area: beforeOrAfterDropAreaSize
  //});
  if (eventCoordinate < targetTabCoordinate + beforeOrAfterDropAreaSize) {
    info.dropPosition = Constants.kDROP_BEFORE;
    info.insertBefore = info.firstTargetTab;
  }
  else if (dropAreasCount == 2 ||
           eventCoordinate > targetTabCoordinate + targetTabSize - beforeOrAfterDropAreaSize) {
    info.dropPosition = Constants.kDROP_AFTER;
    info.insertAfter  = info.lastTargetTab;
  }
  else {
    info.dropPosition = Constants.kDROP_ON_SELF;
  }

  switch (info.dropPosition) {
    case Constants.kDROP_ON_SELF: {
      //log('drop position = on the tab');
      info.action       = Constants.kACTION_ATTACH;
      info.parent       = targetTab;
      info.defineGetter('insertBefore', () => {
        return configs.insertNewChildAt == Constants.kINSERT_FIRST ?
          (Tabs.getFirstChildTab(targetTab) || Tabs.getNextVisibleTab(targetTab)) :
          (Tabs.getNextSiblingTab(targetTab) || Tabs.getNextTab(Tabs.getLastDescendantTab(targetTab) || targetTab));
        // if (info.insertBefore)
        //  log('insertBefore = ', dumpTab(info.insertBefore));
      });
    }; break;

    case Constants.kDROP_BEFORE: {
      //log('drop position = before the tab');
      /* strategy
           +-----------------------------------------------------
           |     <= detach from parent, and move
           |[TARGET  ]
           +-----------------------------------------------------
           |  [      ]
           |     <= attach to the parent of the target, and move
           |[TARGET  ]
           +-----------------------------------------------------
           |[        ]
           |     <= attach to the parent of the target, and move
           |[TARGET  ]
           +-----------------------------------------------------
           |[        ]
           |     <= attach to the parent of the target (previous tab), and move
           |  [TARGET]
           +-----------------------------------------------------
      */
      const prevTab = Tabs.getPreviousVisibleTab(targetTab);
      if (!prevTab) {
        // allow to drop pinned tab to beside of another pinned tab
        if (info.draggedAPITab && info.draggedAPITab.pinned) {
          info.action       = Constants.kACTION_MOVE;
          info.insertBefore = targetTab;
        }
        else {
          info.action       = Constants.kACTION_MOVE | Constants.kACTION_DETACH;
          info.insertBefore = info.firstTargetTab;
        }
      }
      else {
        const prevLevel   = Number(prevTab.getAttribute(Constants.kLEVEL) || 0);
        const targetLevel = Number(targetTab.getAttribute(Constants.kLEVEL) || 0);
        info.parent       = (prevLevel < targetLevel) ? prevTab : Tabs.getParentTab(targetTab) ;
        info.action       = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
        info.insertBefore = targetTab;
      }
      //if (info.insertBefore)
      //  log('insertBefore = ', dumpTab(info.insertBefore));
    }; break;

    case Constants.kDROP_AFTER: {
      //log('drop position = after the tab');
      /* strategy
           +-----------------------------------------------------
           |[TARGET  ]
           |     <= if the target has a parent, attach to it and and move
           +-----------------------------------------------------
           |  [TARGET]
           |     <= attach to the parent of the target, and move
           |[        ]
           +-----------------------------------------------------
           |[TARGET  ]
           |     <= attach to the parent of the target, and move
           |[        ]
           +-----------------------------------------------------
           |[TARGET  ]
           |     <= attach to the target, and move
           |  [      ]
           +-----------------------------------------------------
      */
      const nextTab = Tabs.getNextVisibleTab(targetTab);
      if (!nextTab) {
        info.action = Constants.kACTION_MOVE | Constants.kACTION_ATTACH;
        info.parent = Tabs.getParentTab(targetTab);
      }
      else {
        const targetLevel = Number(targetTab.getAttribute(Constants.kLEVEL) || 0);
        const nextLevel   = Number(nextTab.getAttribute(Constants.kLEVEL) || 0);
        info.parent       = (targetLevel < nextLevel) ? targetTab : Tabs.getParentTab(targetTab) ;
        info.action       = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
        info.insertBefore = nextTab;
        info.insertAfter  = targetTab;
        /* strategy
             +-----------------------------------------------------
             |[TARGET   ]
             |     <= attach dragged tab to the parent of the target as its next sibling
             |  [DRAGGED]
             +-----------------------------------------------------
        */
        if (info.draggedAPITab &&
            info.draggedAPITab.id == nextTab.apiTab.id) {
          info.action       = Constants.kACTION_MOVE | Constants.kACTION_ATTACH;
          info.parent       = Tabs.getParentTab(targetTab);
          info.defineGetter('insertBefore', () => {
            let insertBefore = Tabs.getNextSiblingTab(targetTab);
            let ancestor     = info.parent;
            while (ancestor && !insertBefore) {
              insertBefore = Tabs.getNextSiblingTab(ancestor);
              ancestor     = Tabs.getParentTab(ancestor);
            }
            //if (insertBefore)
            //  log('insertBefore = ', dumpTab(insertBefore));
            return insertBefore;
          });
          info.defineGetter('insertAfter', () => {
            return Tabs.getLastDescendantTab(targetTab);
          });
        }
      }
    }; break;
  }

  return info;
}
function getDropEffectFromDropAction(aActionInfo) {
  if (!aActionInfo.canDrop)
    return 'none';
  if (!aActionInfo.draggedAPITab)
    return 'link';
  if (aActionInfo.isCopyAction)
    return 'copy';
  return 'move';
}

export function clearDropPosition() {
  for (const tab of document.querySelectorAll(`[${Constants.kDROP_POSITION}]`)) {
    tab.removeAttribute(Constants.kDROP_POSITION)
  }
}

export function clearDraggingTabsState() {
  for (const tab of Tabs.getDraggingTabs(Tabs.getWindow())) {
    tab.classList.remove(Constants.kTAB_STATE_DRAGGING);
  }
}

export function clearDraggingState() {
  Tabs.getTabsContainer().classList.remove(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(Constants.kTABBAR_STATE_LINK_DRAGGING);
}

function isDraggingAllTabs(aTab, aTabs) {
  const draggingTabs = Tabs.getDraggingTabs(aTab);
  return draggingTabs.length == (aTabs || Tabs.getAllTabs(aTab)).length;
}
 
function isDraggingAllCurrentTabs(aTab) {
  return isDraggingAllTabs(aTab, Tabs.getAllTabs(aTab));
}

function collapseAutoExpandedTabsWhileDragging() {
  if (gLongHoverExpandedTabs.length > 0 &&
      configs.autoExpandOnLongHoverRestoreIniitalState) {
    for (const tab of gLongHoverExpandedTabs) {
      Tree.collapseExpandSubtree(tab, {
        collapsed: false,
        justNow:   true,
        inRemote:  true
      });
    }
  }
  gLongHoverExpandedTabs = [];
}

async function handleDroppedNonTabItems(aEvent, aDropActionInfo) {
  aEvent.stopPropagation();

  const uris = retrieveURIsFromDragEvent(aEvent);
  // uris.forEach(aURI => {
  //   if (aURI.indexOf(Constants.kURI_BOOKMARK_FOLDER) != 0)
  //     securityCheck(aURI, aEvent);
  // });
  log('handleDroppedNonTabItems: ', uris);

  const dragOverTab = aDropActionInfo.dragOverTab;
  if (dragOverTab &&
      aDropActionInfo.dropPosition == Constants.kDROP_ON_SELF &&
      !Tabs.isLocked(dragOverTab) &&
      !Tabs.isPinned(dragOverTab)) {
    const behavior = await getDroppedLinksOnTabBehavior();
    if (behavior <= Constants.kDROPLINK_ASK)
      return;
    if (behavior & Constants.kDROPLINK_LOAD) {
      browser.runtime.sendMessage({
        type:     Constants.kCOMMAND_SELECT_TAB,
        windowId: Tabs.getWindow(),
        tab:      dragOverTab.id
      });
      await TabsOpen.loadURI(uris.shift(), {
        tab:      dragOverTab,
        inRemote: true
      });
    }
  }
  await TabsOpen.openURIsInTabs(uris, {
    parent:       aDropActionInfo.parent,
    insertBefore: aDropActionInfo.insertBefore,
    insertAfter:  aDropActionInfo.insertAfter,
    inRemote:     true
  });
}

function retrieveURIsFromDragEvent(aEvent) {
  log('retrieveURIsFromDragEvent');
  const dt    = aEvent.dataTransfer;
  const types = [
    kTYPE_X_MOZ_PLACE,
    'text/uri-list',
    'text/x-moz-text-internal',
    'text/x-moz-url',
    'text/plain',
    'application/x-moz-file'
  ];
  let urls = [];
  for (let i = 0; i < types.length; i++) {
    const dataType = types[i];
    for (let i = 0, maxi = dt.mozItemCount; i < maxi; i++) {
      const urlData = dt.mozGetDataAt(dataType, i);
      if (urlData) {
        urls = urls.concat(retrieveURIsFromData(urlData, dataType));
      }
    }
    if (urls.length)
      break;
  }
  log(' => retrieved: ', urls);
  urls = urls.filter(aURI =>
    aURI &&
      aURI.length &&
      aURI.indexOf(kBOOKMARK_FOLDER) == 0 ||
      !/^\s*(javascript|data):/.test(aURI)
  );
  log('  => filtered: ', urls);

  urls = urls.map(fixupURIFromText);
  log('  => fixed: ', urls);

  return urls;
}

function retrieveURIsFromData(aData, aType) {
  log('retrieveURIsFromData: ', aType, aData);
  switch (aType) {
    //case kTYPE_X_MOZ_PLACE: {
    //  const item = JSON.parse(aData);
    //  if (item.type == 'text/x-moz-place-container') {
    //    let children = item.children;
    //    if (!children) {
    //      children = item.children = retrieveBookmarksInFolder(item.id);
    //      aData = JSON.stringify(item);
    //    }
    //    // When a blank folder is dropped, just open a dummy tab with the folder name.
    //    if (children && children.length == 0) {
    //      const uri = TabsGroup.makeGroupTabURI({ title: item.title });
    //      return [uri];
    //    }
    //  }
    //  const uri = item.uri;
    //  if (uri)
    //    return uri;
    //  else
    //    return `${kBOOKMARK_FOLDER}${aData}`;
    //}; break;

    case 'text/uri-list':
      return aData
        .replace(/\r/g, '\n')
        .replace(/^\#.+$/gim, '')
        .replace(/\n\n+/g, '\n')
        .split('\n');

    case 'text/unicode':
    case 'text/plain':
    case 'text/x-moz-text-internal':
      return [aData.trim()];

    //case 'application/x-moz-file':
    //  return [getURLSpecFromFile(aData)];
  }
  return [];
}

function fixupURIFromText(aMaybeURI) {
  if (/^\w+:/.test(aMaybeURI))
    return aMaybeURI;

  if (/^([^\.\s]+\.)+[^\.\s]{2}/.test(aMaybeURI))
    return `http://${aMaybeURI}`;

  return aMaybeURI;
}

async function getDroppedLinksOnTabBehavior() {
  let behavior = configs.dropLinksOnTabBehavior;
  if (behavior != Constants.kDROPLINK_ASK)
    return behavior;

  const confirm = new RichConfirm({
    message: browser.i18n.getMessage('dropLinksOnTabBehavior_message'),
    buttons: [
      browser.i18n.getMessage('dropLinksOnTabBehavior_load'),
      browser.i18n.getMessage('dropLinksOnTabBehavior_newtab')
    ],
    checkMessage: browser.i18n.getMessage('dropLinksOnTabBehavior_save')
  });
  const result = await confirm.show();
  switch (result.buttonIndex) {
    case 0:
      behavior = Constants.kDROPLINK_LOAD;
      break;
    case 1:
      behavior = Constants.kDROPLINK_NEWTAB;
      break;
    default:
      return result.buttonIndex;
  }
  if (result.checked)
    configs.dropLinksOnTabBehavior = behavior;
  return behavior;
}


/* DOM event listeners */

function onDragStart(aEvent) {
  clearDraggingTabsState(); // clear previous state anyway

  const dragData = getDragDataFromOneTab(aEvent.target, {
    shouldIgnoreDescendants: aEvent.shiftKey
  });
  if (!dragData.tabNode)
    return;

  const tab       = dragData.tabNode
  const mousedown = EventUtils.getLastMousedown(aEvent.button);

  if (mousedown && mousedown.expired) {
    aEvent.stopPropagation();
    aEvent.preventDefault();
    gLastDragEnteredTarget = tab;
    const startOnClosebox = gDragTargetIsClosebox = mousedown.detail.closebox;
    if (startOnClosebox)
      gLastDragEnteredTarget = SidebarTabs.getTabClosebox(tab);
    TSTAPI.sendMessage({
      type:   TSTAPI.kNOTIFY_TAB_DRAGSTART,
      tab:    TSTAPI.serializeTab(tab),
      window: Tabs.getWindow(),
      startOnClosebox
    });
    window.addEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.addEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.body.setCapture(false);
    gCapturingForDragging = true;
    return;
  }

  if (!EventUtils.cancelHandleMousedown()) {
    // this action is already handled as "click".
    //return;
  }

  // dragging on clickable element will be expected to cancel the operation
  if (EventUtils.isEventFiredOnClosebox(aEvent) ||
      EventUtils.isEventFiredOnClickable(aEvent)) {
    aEvent.stopPropagation();
    aEvent.preventDefault();
    return;
  }

  gDraggingOnSelfWindow = true;
  gLastDropPosition = null;

  const dt = aEvent.dataTransfer;
  dt.effectAllowed = 'copyMove';

  const sanitizedDragData = sanitizeDragData(dragData);
  dt.mozSetDataAt(kTREE_DROP_TYPE, JSON.stringify(sanitizedDragData), 0);

  // Because addon cannot read drag data across private browsing mode,
  // we need to share detailed information of dragged tabs in different way!
  gCurrentDragData = sanitizedDragData;
  browser.runtime.sendMessage({
    type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
    windowId: Tabs.getWindow(),
    dragData: sanitizedDragData
  });

  dragData.tabNodes.map((aDraggedTab, aIndex) => {
    aDraggedTab.classList.add(Constants.kTAB_STATE_DRAGGING);
    // this type will be...
    //  * droppable on bookmark toolbar and other Places based UI
    //  * undroppable on content area, desktop, and other application
    // so this won't block tearing off of tabs by drag-and-drop.
    dt.mozSetDataAt(kTYPE_X_MOZ_PLACE,
                    JSON.stringify({
                      type:  kTYPE_X_MOZ_PLACE,
                      uri:   aDraggedTab.apiTab.url,
                      title: aDraggedTab.apiTab.title
                    }),
                    aIndex);
  });
  Tabs.getTabsContainer(tab).classList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);

  document.addEventListener('dragend', onDragEnd, { capture: true });
}

let gLastDragOverTimestamp = null;

function onDragOver(aEvent) {
  aEvent.preventDefault(); // this is required to override default dragover actions!
  Scroll.autoScrollOnMouseEvent(aEvent);

  // reduce too much handling of too frequent dragover events...
  const now = Date.now();
  if (now - (gLastDragOverTimestamp || 0) < configs.minimumIntervalToProcessDragoverEvent)
    return;
  gLastDragOverTimestamp = now;

  const info = getDropAction(aEvent);
  const dt   = aEvent.dataTransfer;

  if (isEventFiredOnTabDropBlocker(aEvent) ||
      !info.canDrop) {
    dt.dropEffect = 'none';
    if (gLastDropPosition)
      clearDropPosition();
    gLastDropPosition = null;
    return;
  }

  let dropPositionTargetTab = info.targetTab;
  while (Tabs.isCollapsed(dropPositionTargetTab)) {
    dropPositionTargetTab = Tabs.getPreviousTab(dropPositionTargetTab);
  }
  if (!dropPositionTargetTab)
    dropPositionTargetTab = info.targetTab;

  if (!dropPositionTargetTab) {
    dt.dropEffect = 'none';
    gLastDropPosition = null;
    return;
  }

  if (!info.draggedAPITab ||
      dropPositionTargetTab.apiTab.id != info.draggedAPITab.id) {
    const dropPosition = `${dropPositionTargetTab.id}:${info.dropPosition}`;
    if (dropPosition == gLastDropPosition)
      return;
    clearDropPosition();
    dropPositionTargetTab.setAttribute(Constants.kDROP_POSITION, info.dropPosition);
    gLastDropPosition = dropPosition;
    log('set drop position to ', dropPosition);
  }
  else {
    gLastDropPosition = null;
  }
}

function isEventFiredOnTabDropBlocker(aEvent) {
  let node = aEvent.target;
  if (node.nodeType != Node.ELEMENT_NODE)
    node = node.parentNode;
  return node && !!node.closest('.tab-drop-blocker');
}

function onDragEnter(aEvent) {
  if (gDelayedDragEnter) {
    clearTimeout(gDelayedDragEnter);
    gDelayedDragEnter = null;
  }
  gDelayedDragEnter = setTimeout(() => {
    gDelayedDragEnter = null;
    gDraggingOnSelfWindow = true;
    if (gDelayedDragLeave) {
      clearTimeout(gDelayedDragLeave);
      gDelayedDragLeave = null;
    }
  }, 10);

  const info = getDropAction(aEvent);
  const dt   = aEvent.dataTransfer;
  dt.dropEffect = info.dropEffect;
  if (info.dropEffect == 'link')
    document.documentElement.classList.add(Constants.kTABBAR_STATE_LINK_DRAGGING);

  if (!configs.autoExpandOnLongHover ||
      !info.canDrop ||
      !info.dragOverTab)
    return;

  reserveToProcessLongHover.cancel();

  if (info.draggedAPITab &&
      info.dragOverTab.apiTab.id == info.draggedAPITab.id)
    return;

  reserveToProcessLongHover({
    dragOverTabId: info.targetTab.id,
    draggedTabId:  info.draggedTab && info.draggedTab.id,
    dropEffect:    info.dropEffect
  });
}

function reserveToProcessLongHover(aParams = {}) {
  gLongHoverTimerNext = setTimeout(() => {
    gLongHoverTimerNext = null;
    gLongHoverTimer = setTimeout(async () => {
      log('reservedProcessLongHover: ', aParams);

      const dragOverTab = Tabs.getTabById(aParams.dragOverTabId);
      if (!dragOverTab ||
          dragOverTab.getAttribute(Constants.kDROP_POSITION) != 'self')
        return;

      // auto-switch for staying on tabs
      if (!Tabs.isActive(dragOverTab) &&
          aParams.dropEffect == 'link') {
        browser.runtime.sendMessage({
          type:     Constants.kCOMMAND_SELECT_TAB,
          windowId: Tabs.getWindow(),
          tab:      dragOverTab.id
        });
      }

      if (!Tree.shouldTabAutoExpanded(dragOverTab))
        return;

      // auto-expand for staying on a parent
      if (configs.autoExpandIntelligently) {
        Tree.collapseExpandTreesIntelligentlyFor(dragOverTab, { inRemote: true });
      }
      else {
        if (!gLongHoverExpandedTabs.includes(aParams.dragOverTabId))
          gLongHoverExpandedTabs.push(aParams.dragOverTabId);
        Tree.collapseExpandSubtree(dragOverTab, {
          collapsed: false,
          inRemote:  true
        });
      }
    }, configs.autoExpandOnLongHoverDelay);
  }, 0);
}
reserveToProcessLongHover.cancel = function() {
  clearTimeout(gLongHoverTimer);
  clearTimeout(gLongHoverTimerNext);
};

function onDragLeave(_aEvent) {
  if (gDelayedDragLeave) {
    clearTimeout(gDelayedDragLeave);
    gDelayedDragLeave = null;
  }
  setTimeout(() => {
    gDelayedDragLeave = setTimeout(() => {
      gDelayedDragLeave = null;
      gDraggingOnSelfWindow = false;
      clearDropPosition();
      clearDraggingState();
      gLastDropPosition = null;
    }, configs.preventTearOffTabsTimeout);
  }, 10);

  clearTimeout(gLongHoverTimer);
  gLongHoverTimer = null;
}

function onDrop(aEvent) {
  setTimeout(() => collapseAutoExpandedTabsWhileDragging(), 0);
  if (gLastDropPosition) {
    clearDropPosition();
    gLastDropPosition = null;
  }

  const dropActionInfo = getDropAction(aEvent);
  const dt = aEvent.dataTransfer;
  if (dt.dropEffect != 'link' &&
      dt.dropEffect != 'move' &&
      dropActionInfo.dragData &&
      !dropActionInfo.dragData.apiTab) {
    log('invalid drop');
    return;
  }

  if (dropActionInfo.dragData &&
      dropActionInfo.dragData.apiTab) {
    log('there are dragged tabs');
    Tree.performTabsDragDrop({
      windowId:            dropActionInfo.dragData.windowId,
      tabs:                dropActionInfo.dragData.apiTabs,
      action:              dropActionInfo.action,
      attachTo:            dropActionInfo.parent,
      insertBefore:        dropActionInfo.insertBefore,
      insertAfter:         dropActionInfo.insertAfter,
      destinationWindowId: Tabs.getWindow(),
      duplicate:           dt.dropEffect == 'copy',
      inRemote:            true
    });
    return;
  }

  log('link or bookmark item is dropped');
  handleDroppedNonTabItems(aEvent, dropActionInfo);
}

function onDragEnd(aEvent) {
  log('onDragEnd, gDraggingOnSelfWindow = ', gDraggingOnSelfWindow);

  document.removeEventListener('dragend', onDragEnd, { capture: true });

  // clear "dragging" status safely, because we possibly fail to get drag data from dataTransfer.
  clearDraggingTabsState();

  let dragData = aEvent.dataTransfer.mozGetDataAt(kTREE_DROP_TYPE, 0);
  dragData = (dragData && JSON.parse(dragData)) || gCurrentDragData;
  const stillInSelfWindow = !!gDraggingOnSelfWindow;
  gDraggingOnSelfWindow = false;

  wait(100).then(() => {
    gCurrentDragData = null;
    browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
      windowId: Tabs.getWindow(),
      dragData: null
    });
  });

  if (Array.isArray(dragData.apiTabs))
    dragData.tabNodes = dragData.apiTabs.map(Tabs.getTabById);

  clearDropPosition();
  gLastDropPosition = null;
  clearDraggingState();
  collapseAutoExpandedTabsWhileDragging();

  if (aEvent.dataTransfer.dropEffect != 'none' ||
      //aEvent.shiftKey || // don't ignore shift-drop, because it can be used to drag a parent tab as an individual tab.
      !configs.moveDroppedTabToNewWindowForUnhandledDragEvent) {
    log('dragged items are processed by someone: ', aEvent.dataTransfer.dropEffect);
    return;
  }

  const dropTargetTab = EventUtils.getTabFromEvent(aEvent);
  if (dropTargetTab &&
      dragData &&
      dragData.tabNodes &&
      !dragData.tabNodes.includes(dropTargetTab)) {
    log('ignore drop on dragged tabs themselves');
    return;
  }

  log('trying to detach tab from window');
  aEvent.stopPropagation();
  aEvent.preventDefault();

  if (stillInSelfWindow) {
    log('dropped at tab bar: detaching is canceled');
    return;
  }

  const now = Date.now();
  const delta = now - gLastDragOverTimestamp;
  log('LastDragOverTimestamp: ', {
    last: gLastDragOverTimestamp,
    now, delta,
    timeout: configs.preventTearOffTabsTimeout
  });
  if (gLastDragOverTimestamp &&
      delta < configs.preventTearOffTabsTimeout) {
    log('dropped near the tab bar: detaching is canceled');
    return;
  }

  if (isDraggingAllCurrentTabs(dragData.tabNode)) {
    log('all tabs are dragged, so it is nonsence to tear off them from the window');
    return;
  }

  Tree.openNewWindowFromTabs(dragData.tabNodes, {
    duplicate: EventUtils.isAccelKeyPressed(aEvent),
    left:      aEvent.screenX,
    top:       aEvent.screenY,
    inRemote:  true
  });
}


/* drag on tabs API */

export function onTSTAPIDragEnter(aEvent) {
  Scroll.autoScrollOnMouseEvent(aEvent);
  const tab = EventUtils.getTabFromEvent(aEvent);
  let target = tab;
  if (gDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(aEvent))
    target = SidebarTabs.getTabClosebox(tab);
  cancelDelayedTSTAPIDragExitOn(target);
  if (tab &&
      (!gDragTargetIsClosebox ||
       EventUtils.isEventFiredOnClosebox(aEvent))) {
    if (target != gLastDragEnteredTarget) {
      TSTAPI.sendMessage({
        type:   TSTAPI.kNOTIFY_TAB_DRAGENTER,
        tab:    TSTAPI.serializeTab(tab),
        window: Tabs.getWindow()
      });
    }
  }
  gLastDragEnteredTarget = target;
}

export function onTSTAPIDragExit(aEvent) {
  if (gDragTargetIsClosebox &&
      !EventUtils.isEventFiredOnClosebox(aEvent))
    return;
  const tab = EventUtils.getTabFromEvent(aEvent);
  if (!tab)
    return;
  let target = tab;
  if (gDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(aEvent))
    target = SidebarTabs.getTabClosebox(tab);
  cancelDelayedTSTAPIDragExitOn(target);
  target.onTSTAPIDragExitTimeout = setTimeout(() => {
    delete target.onTSTAPIDragExitTimeout;
    TSTAPI.sendMessage({
      type:   TSTAPI.kNOTIFY_TAB_DRAGEXIT,
      tab:    TSTAPI.serializeTab(tab),
      window: Tabs.getWindow()
    });
  }, 10);
}

function cancelDelayedTSTAPIDragExitOn(aTarget) {
  if (aTarget && aTarget.onTSTAPIDragExitTimeout) {
    clearTimeout(aTarget.onTSTAPIDragExitTimeout);
    delete aTarget.onTSTAPIDragExitTimeout;
  }
}

