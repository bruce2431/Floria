/**
 * Watches the terminal for OSC 11 background color changes and updates the
 * cached system theme. Imported only when the AUTO_THEME feature flag is on;
 * otherwise dead-code-eliminated by the build.
 *
 * @module
 */

const { themeFromOscColor, setCachedSystemTheme } = require('./systemTheme.js')

/**
 * The OSC 11 query string sent to the terminal to request its background color.
 * Wrapped in a BEL-terminated sequence so the terminal responds with the same
 * delimiter.
 */
const OSC_11_QUERY = '\x1b]11;?\x07'

/**
 * Start polling the terminal for its background color (OSC 11).
 *
 * @param {(query: string) => Promise<string>} querier  - Sends an escape
 *        sequence to the terminal and returns the response string.
 * @param {(theme: 'dark' | 'light') => void} setSystemTheme - React setter
 *        called on each successful parse.
 * @returns {() => void} A cleanup function that stops the polling interval.
 */
function watchSystemTheme(querier, setSystemTheme) {
  // Fire once immediately so the UI doesn't wait up to 5 s for the first poll.
  poll()
  const interval = setInterval(poll, 5000)
  return function cleanup() {
    clearInterval(interval)
  }

  /** Perform a single OSC 11 query and process the result. */
  function poll() {
    // The querier may reject if the terminal is unresponsive. Swallow errors
    // silently — the existing cached theme (or COLORFGBG seed) is good enough.
    querier(OSC_11_QUERY)
      .then((response) => {
        const theme = themeFromOscColor(response)
        if (theme !== undefined) {
          setCachedSystemTheme(theme)
          setSystemTheme(theme)
        }
      })
      .catch(() => {
        /* ignore transient terminal errors */
      })
  }
}

module.exports = { watchSystemTheme }
