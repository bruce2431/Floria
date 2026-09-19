import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { Text } from 'src/ink.js';
import { getRateLimitWarning, getUsingOverageText } from 'src/services/claudeAiLimits.js';
import { useClaudeAiLimits } from 'src/services/claudeAiLimitsHook.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
export function useRateLimitWarningNotification(model) {
  const $ = _c(15);
  const {
    addNotification
  } = useNotifications();
  const claudeAiLimits = useClaudeAiLimits();
  let t0;
  if ($[0] !== claudeAiLimits || $[1] !== model) {
    t0 = getRateLimitWarning(claudeAiLimits, model);
    $[0] = claudeAiLimits;
    $[1] = model;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  const rateLimitWarning = t0;
  let t1;
  if ($[3] !== claudeAiLimits) {
    t1 = getUsingOverageText(claudeAiLimits);
    $[3] = claudeAiLimits;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const usingOverageText = t1;
  const shownWarningRef = useRef(null);
  const [hasShownOverageNotification, setHasShownOverageNotification] = useState(false);
  let t2;
  let t3;
  if ($[5] !== addNotification || $[6] !== claudeAiLimits.isUsingOverage || $[7] !== hasShownOverageNotification || $[8] !== usingOverageText) {
    t2 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (claudeAiLimits.isUsingOverage && !hasShownOverageNotification) {
        addNotification({
          key: "limit-reached",
          text: usingOverageText,
          priority: "immediate"
        });
        setHasShownOverageNotification(true);
      } else {
        if (!claudeAiLimits.isUsingOverage && hasShownOverageNotification) {
          setHasShownOverageNotification(false);
        }
      }
    };
    t3 = [claudeAiLimits.isUsingOverage, usingOverageText, hasShownOverageNotification, addNotification];
    $[5] = addNotification;
    $[6] = claudeAiLimits.isUsingOverage;
    $[7] = hasShownOverageNotification;
    $[8] = usingOverageText;
    $[9] = t2;
    $[10] = t3;
  } else {
    t2 = $[9];
    t3 = $[10];
  }
  useEffect(t2, t3);
  let t4;
  let t5;
  if ($[11] !== addNotification || $[12] !== rateLimitWarning) {
    t4 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (rateLimitWarning && rateLimitWarning !== shownWarningRef.current) {
        shownWarningRef.current = rateLimitWarning;
        addNotification({
          key: "rate-limit-warning",
          jsx: <Text><Text color="warning">{rateLimitWarning}</Text></Text>,
          priority: "high"
        });
      }
    };
    t5 = [rateLimitWarning, addNotification];
    $[11] = addNotification;
    $[12] = rateLimitWarning;
    $[13] = t4;
    $[14] = t5;
  } else {
    t4 = $[13];
    t5 = $[14];
  }
  useEffect(t4, t5);
}
