import * as React from 'react';
import { Text } from '../ink.js';
import { shouldEnableClaudeInChrome } from '../utils/claudeInChrome/setup.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';
function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) {
    return true;
  }
  if (process.argv.includes('--no-chrome')) {
    return false;
  }
  return undefined;
}
export function useChromeExtensionNotification() {
  useStartupNotification(_temp);
}
async function _temp() {
  const chromeFlag = getChromeFlag();
  if (!shouldEnableClaudeInChrome(chromeFlag)) {
    return null;
  }
  // OAuth 订阅线路已移除：Chrome 扩展仅限订阅者，恒提示订阅要求
  return {
    key: "chrome-requires-subscription",
    jsx: <Text color="error">Claude in Chrome requires a claude.ai subscription</Text>,
    priority: "immediate",
    timeoutMs: 5000
  };
}
