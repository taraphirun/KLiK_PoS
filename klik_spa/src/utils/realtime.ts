import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/** Mirrors frappe/public/js/frappe/socketio_client.js's get_host(): in production, connect to
 * the same origin and let nginx proxy /socket.io to the internal Node server (this is how Desk's
 * own realtime client connects on this exact site). This SPA has no frappe.boot to read
 * socketio_port from, so the dev-server (Vite's own port, separate from the Frappe site) branch
 * falls back to the page's hostname on the default port (9000, matching
 * common_site_config.json's socketio_port unless your bench overrides it). */
function getSocketHost(): string {
  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:9000`;
  }
  return window.location.origin;
}

/** Lazily creates (and reuses) the site's realtime socket connection. Namespace is the site
 * name, which for a dns_multitenant site accessed by its real domain is the hostname itself -
 * same convention Desk's socketio_client.js uses via frappe.boot.sitename. */
export function getRealtimeSocket(): Socket {
  if (socket) return socket;

  const siteName = window.location.hostname;
  socket = io(`${getSocketHost()}/${siteName}`, {
    withCredentials: true,
    reconnectionAttempts: 5,
  });

  return socket;
}
