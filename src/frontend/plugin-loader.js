const _plugins = new Map();
let _activePlugin = null;

export function registerPlugin(plugin) {
  if (!plugin.id) throw new Error('Plugin must have an id');
  _plugins.set(plugin.id, plugin);
}

export function getPlugin(id) {
  return _plugins.get(id) || null;
}

export function getActivePlugin() {
  return _activePlugin;
}

export function mountPlugin(id, container) {
  if (_activePlugin && _activePlugin.id !== id) {
    if (_activePlugin.unmount) _activePlugin.unmount();
  }
  const plugin = _plugins.get(id);
  if (!plugin) return null;
  _activePlugin = plugin;
  if (plugin.mount) plugin.mount(container);
  return plugin;
}

export function unmountActivePlugin() {
  if (_activePlugin && _activePlugin.unmount) {
    _activePlugin.unmount();
  }
  _activePlugin = null;
}

export function notifyPlugins(event, data) {
  for (const plugin of _plugins.values()) {
    if (event === 'walletConnect' && plugin.onWalletConnect) plugin.onWalletConnect(data);
    if (event === 'walletDisconnect' && plugin.onWalletDisconnect) plugin.onWalletDisconnect(data);
    if (event === 'relayEvent' && plugin.onRelayEvent) plugin.onRelayEvent(data);
  }
}
