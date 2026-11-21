/**
 * Wire protocol version shared with native hosts.
 *
 * Native integrations may inspect it through the global receiver object.
 * @public
 */
export const VERSION = '1.0.0';

/**
 * Default `WKScriptMessageHandler` name used for the native channel.
 * @public
 */
export const DEFAULT_CHANNEL = 'bridge';

/**
 * Default call timeout in milliseconds. `0` disables timeouts.
 * @public
 */
export const DEFAULT_TIMEOUT = 10_000;

/**
 * Default global property the native side calls to push messages.
 * @public
 */
export const DEFAULT_RECEIVE_KEY = '__wkbridge__';

/**
 * Default global array used to queue messages before the bridge boots.
 * @public
 */
export const DEFAULT_INBOX_KEY = '__wkbridgeInbox__';
