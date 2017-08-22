/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

async function attachTabTo(aChild, aParent, aInfo = {}) {
  if (!aParent || !aChild) {
    log('missing information: ', dumpTab(aParent), dumpTab(aChild));
    return;
  }
  log('attachTabTo: ', {
    parent:   dumpTab(aParent),
    children: aParent.getAttribute(kCHILDREN),
    child:    dumpTab(aChild),
    info:     aInfo
  });
  if (aParent.getAttribute(kCHILDREN).indexOf(`|${aChild.id}|`) > -1) {
    log('=> already attached');
    return;
  }
  var ancestors = [aParent].concat(getAncestorTabs(aChild));
  if (ancestors.indexOf(aChild) > -1) {
    log('=> canceled for recursive request');
    return;
  }

  detachTab(aChild);

  var newIndex = -1;
  if (aInfo.dontMove)
    aInfo.insertBefore = getNextTab(aChild);
  if (aInfo.insertBefore) {
    log('insertBefore: ', dumpTab(aInfo.insertBefore));
    newIndex = getTabIndex(aInfo.insertBefore);
  }
  var childIds = [];
  if (newIndex > -1) {
    log('newIndex (from insertBefore): ', newIndex);
    let expectedAllTabs = getAllTabs(aChild).filter((aTab) => aTab != aChild);
    let refIndex = expectedAllTabs.indexOf(aInfo.insertBefore);
    expectedAllTabs.splice(refIndex, 0, aChild);
    childIds = expectedAllTabs.filter((aTab) => {
      return (aTab == aChild || aTab.getAttribute(kPARENT) == aParent.id);
    }).map((aTab) => {
      return aTab.id;
    });
  }
  else {
    let descendants = getDescendantTabs(aParent);
    log('descendants: ', descendants.map(dumpTab));
    if (descendants.length) {
      newIndex = getTabIndex(descendants[descendants.length-1]) + 1;
    }
    else {
      newIndex = getTabIndex(aParent) + 1;
    }
    log('newIndex (from existing children): ', newIndex);
    // update and cleanup
    let children = getChildTabs(aParent);
    children.push(aChild);
    childIds = children.map((aTab) => aTab.id);
  }

  if (childIds.length == 0)
    aParent.setAttribute(kCHILDREN, '|');
  else
    aParent.setAttribute(kCHILDREN, `|${childIds.join('|')}|`);

  if (getTabIndex(aChild) < newIndex)
    newIndex--;
  log('newIndex: ', newIndex);

  aChild.setAttribute(kPARENT, aParent.id);
  var parentLevel = parseInt(aParent.getAttribute(kNEST) || 0);
  updateTabsIndent(aChild, parentLevel + 1);

  gInternalMovingCount++;
  var nextTab = getTabs(aChild)[newIndex];
  if (nextTab != aChild)
    getTabsContainer(nextTab || aChild).insertBefore(aChild, nextTab);

  var [actualChildIndex, actualNewIndex] = await getApiTabIndex(aChild.apiTab.id, nextTab.apiTab.id);
  if (actualChildIndex < actualNewIndex)
    actualNewIndex--;

  log('actualNewIndex: ', actualNewIndex);
  browser.tabs.move(aChild.apiTab.id, {
    windowId: aChild.apiTab.windowId,
    index:    actualNewIndex
  });
  setTimeout(() => {
    gInternalMovingCount--;
  });

  if (gIsBackground)
    reserveToSaveTreeStructure(aChild);
}

function detachTab(aChild, aInfo = {}) {
  log('detachTab: ', dumpTab(aChild), aInfo);
  var parent = getParentTab(aChild);
  if (!parent) {
    log('canceled for an orphan tab');
    return;
  }

  var childIds = parent.getAttribute(kCHILDREN).split('|').filter((aId) => aId && aId != aChild.id);
  if (childIds.length == 0)
    parent.setAttribute(kCHILDREN, '|');
  else
    parent.setAttribute(kCHILDREN, `|${childIds.join('|')}|`);
  log('children => ', parent.getAttribute(kCHILDREN));
  aChild.removeAttribute(kPARENT);

  updateTabsIndent(aChild);

  if (gIsBackground)
    reserveToSaveTreeStructure(aChild);
}

function detachAllChildren(aTab, aInfo = {}) {
  var children = getChildTabs(aTab);
  if (!children.length)
    return;

  if (!('behavior' in aInfo))
    aInfo.behavior = kCLOSE_PARENT_BEHAVIOR_SIMPLY_DETACH_ALL_CHILDREN;
  if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN)
    aInfo.behavior = kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;

  aInfo.dontUpdateInsertionPositionInfo = true;

  var parent = getParentTab(aTab);
  if (isGroupTab(aTab) &&
      getTabs(aTab).filter((aTab) => aTab.removing).length == children.length) {
    aInfo.behavior = kCLOSE_PARENT_BEHAVIOR_PROMOTE_ALL_CHILDREN;
    aInfo.dontUpdateIndent = false;
  }

  var nextTab = null;
  if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_DETACH_ALL_CHILDREN/* &&
    !utils.getTreePref('closeParentBehavior.moveDetachedTabsToBottom')*/) {
    nextTab = getNextSiblingTab(getRootTab(aTab));
  }

  if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_REPLACE_WITH_GROUP_TAB) {
    // open new group tab and replace the detaching tab with it.
    aInfo.behavior = kCLOSE_PARENT_BEHAVIOR_PROMOTE_ALL_CHILDREN;
  }

  for (let i = 0, maxi = children.length; i < maxi; i++) {
    let child = children[i];
    if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_DETACH_ALL_CHILDREN) {
      detachTab(child, aInfo);
      //moveTabSubtreeTo(tab, nextTab ? nextTab._tPos - 1 : this.getLastTab(b)._tPos );
    }
    else if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD) {
      detachTab(child, aInfo);
      if (i == 0) {
        if (parent) {
          attachTabTo(child, parent, inherit(aInfo, {
            dontExpand : true,
            dontMove   : true
          }));
        }
        //collapseExpandSubtree(child, false);
        //deleteTabValue(child, kSUBTREE_COLLAPSED);
      }
      else {
        attachTabTo(child, children[0], inherit(aInfo, {
          dontExpand : true,
          dontMove   : true
        }));
      }
    }
    else if (aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_PROMOTE_ALL_CHILDREN && parent) {
      attachTabTo(child, parent, inherit(aInfo, {
        dontExpand : true,
        dontMove   : true
      }));
    }
    else { // aInfo.behavior == kCLOSE_PARENT_BEHAVIOR_SIMPLY_DETACH_ALL_CHILDREN
      detachTab(child, aInfo);
    }
  }
}

function updateTabsIndent(aTabs, aLevel = undefined) {
  if (!aTabs)
    return;

  if (!Array.isArray(aTabs))
    aTabs = [aTabs];

  if (!aTabs.length)
    return;

  if (aLevel === undefined)
    aLevel = getAncestorTabs(aTabs[0]).length;

  var margin = 16;
  for (let i = 0, maxi = aTabs.length; i < maxi; i++) {
    let item = aTabs[i];
    if (!item)
      continue;
    if (!gIsBackground) {
      window.requestAnimationFrame(() => {
        var level = parseInt(item.getAttribute(kNEST) || 0);
        var indent = level * margin;
        var expected = indent == 0 ? 0 : indent + 'px' ;
        log('setting indent: ', { tab: dumpTab(item), expected: expected, level: level });
        if (item.style.marginLeft != expected) {
          window.requestAnimationFrame(() => item.style.marginLeft = expected);
        }
      });
    }
    item.setAttribute(kNEST, aLevel);
    updateTabsIndent(getChildTabs(item), aLevel + 1);
  }
}


// collapse/expand tabs

async function updateTabCollapsed(aTab, aParams = {}) {
  log('updateTabCollapsed ', dumpTab(aTab));
  if (!aTab.parentNode) // do nothing for closed tab!
    return;

  aTab.setAttribute(kCOLLAPSING_PHASE, aParams.collapsed ? kCOLLAPSING_PHASE_TO_BE_COLLAPSED : kCOLLAPSING_PHASE_TO_BE_EXPANDED );

  var firstTab = getFirstNormalTab(aTab) || getFirstTab(aTab);
  var maxMargin = firstTab.getBoundingClientRect().height;
  if (firstTab.style.height)
    aTab.style.height = firstTab.style.height;

  var startMargin, endMargin, endOpacity;
  var startOpacity = window.getComputedStyle(aTab).opacity;
  if (aParams.collapsed) {
    startMargin  = 0;
    endMargin    = maxMargin;
    endOpacity   = 0;
  }
  else {
    startMargin  = maxMargin;
    endMargin    = 0;
    startOpacity = 0;
    endOpacity   = 1;
  }
  log('animation params: ', {
    startMargin  : startMargin,
    endMargin    : endMargin,
    startOpacity : startOpacity,
    endOpacity   : endOpacity
  });

  if (
    !canAnimate() ||
    aParams.justNow ||
    configs.collapseDuration < 1 // ||
//      !canCollapseSubtree(getParentTab(aTab))
    ) {
    log(' => skip animation');
    if (aParams.collapsed)
      aTab.classList.add(kCOLLAPSED_DONE);
    else
      aTab.classList.remove(kCOLLAPSED_DONE);
    aTab.removeAttribute(kCOLLAPSING_PHASE);

    // Pinned tabs are positioned by "margin-top", so
    // we must not reset the property for pinned tabs.
    // (However, we still must update "opacity".)
    let pinned = aTab.classList.contains('pinned');
    let canExpand = !pinned;

    log(' skipped animation params: ', {
      pinned    : pinned,
      canExpand : canExpand,
      endMargin : endMargin
    });

    if (canExpand)
      aTab.style.marginTop = endMargin ? '-'+endMargin+'px' : '';

    if (endOpacity == 0)
      aTab.style.opacity = 0;
    else
      aTab.style.opacity = '';

    if (typeof aParams.onStart == 'function')
      aParams.onStart();
    return;
  }

  aTab.style.marginTop = startMargin ? '-'+startMargin+'px' : '';
  aTab.style.opacity = startOpacity;

  if (!aParams.collapsed)
    aTab.classList.remove(kCOLLAPSED_DONE);

  return new Promise((aResolve, aReject) => {
    window.requestAnimationFrame(() => {
      aTab.addEventListener('transitionend', () => {
        log(' => finish animation for ', dumpTab(aTab));
        if (aParams.collapsed)
          aTab.classList.add(kCOLLAPSED_DONE);
        aTab.removeAttribute(kCOLLAPSING_PHASE);

        if (endOpacity > 0) {
          if (window.getComputedStyle(aTab).opacity > 0) {
            aTab.style.opacity = '';
            aTab = null;
          }
          else {
            // If we clear its "opacity" before it becomes "1"
            // by CSS transition, the calculated opacity will
            // become 0 after we set an invalid value to clear it.
            // So we have to clear it with delay.
            // This is workaround for the issue:
            //   https://github.com/piroor/treestyletab/issues/1202
            setTimeout(function() {
              aTab.style.opacity = '';
              aTab = null;
            }, 0);
          }
        }

        maxMargin = null;
        startMargin = null;
        endMargin = null;
        startOpacity = null;
        endOpacity = null;

        aResolve();
      }, { once: true });

      if (typeof aParams.onStart == 'function')
        aParams.onStart();
      aTab.style.marginTop = endMargin ? '-'+endMargin+'px' : '';
      aTab.style.opacity = endOpacity;
    });
  });
}


// operate tabs based on tree information

function closeChildTabs(aParent) {
  var getDescendantTabs;
}


// set/get tree structure

function getTreeStructureFromTabs(aTabs) {
  if (!aTabs || !aTabs.length)
    return [];

  /* this returns...
    [A]     => -1 (parent is not in this tree)
      [B]   => 0 (parent is 1st item in this tree)
      [C]   => 0 (parent is 1st item in this tree)
        [D] => 2 (parent is 2nd in this tree)
    [E]     => -1 (parent is not in this tree, and this creates another tree)
      [F]   => 0 (parent is 1st item in this another tree)
  */
  return this.cleanUpTreeStructureArray(
      aTabs.map((aTab, aIndex) => {
        let tab = getParentTab(aTab);
        let index = tab ? aTabs.indexOf(tab) : -1 ;
        return index >= aIndex ? -1 : index ;
      }),
      -1
    );
}
function cleanUpTreeStructureArray(aTreeStructure, aDefaultParent) {
  var offset = 0;
  aTreeStructure = aTreeStructure
    .map((aPosition, aIndex) => {
      return (aPosition == aIndex) ? -1 : aPosition ;
    })
    .map((aPosition, aIndex) => {
      if (aPosition == -1) {
        offset = aIndex;
        return aPosition;
      }
      return aPosition - offset;
    });

  /* The final step, this validates all of values.
     Smaller than -1 is invalid, so it becomes to -1. */
  aTreeStructure = aTreeStructure.map(aIndex => {
      return aIndex < -1 ? aDefaultParent : aIndex ;
    });
  return aTreeStructure;
}

function applyTreeStructureToTabs(aTabs, aTreeStructure, aExpandStates) {
  log('applyTreeStructureToTabs: ', aTreeStructure, aExpandStates);
  aTabs = aTabs.slice(0, aTreeStructure.length);
  aTreeStructure = aTreeStructure.slice(0, aTabs.length);

  aExpandStates = (aExpandStates && typeof aExpandStates == 'object') ?
            aExpandStates :
            aTabs.map(aTab => !!aExpandStates);
  aExpandStates = aExpandStates.slice(0, aTabs.length);
  while (aExpandStates.length < aTabs.length)
    aExpandStates.push(-1);

  var parentTab = null;
  for (let i = 0, maxi = aTabs.length; i < maxi; i++) {
    let tab = aTabs[i];
    //if (isCollapsed(tab))
    //  collapseExpandTab(tab, false, true);
    detachTab(tab);

    let parentIndexInTree = aTreeStructure[i];
    if (parentIndexInTree < 0) // there is no parent, so this is a new parent!
      parentTab = tab.id;

    let parent = findTabById(parentTab);
    if (parent) {
      let tabs = [parent].concat(getDescendantTabs(parent));
      parent = parentIndexInTree < tabs.length ? tabs[parentIndexInTree] : parent ;
    }
    if (parent) {
      attachTabTo(tab, parent, {
        forceExpand : true,
        dontMove    : true
      });
    }
  }

  //for (let i = aTabs.length-1; i > -1; i--) {
  //  collapseExpandSubtree(aTabs[i], !hasChildTabs(aTabs[i]) || !aExpandStates[i], true);
  //}
}


function scrollToNewTab(aTab) {
}

function updateInsertionPositionInfo(aTab) {
}