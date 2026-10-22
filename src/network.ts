import { setDefaultResultOrder } from 'node:dns';

let configured = false;

/**
 * Prefer IPv4 for outbound Node.js connections.
 *
 * TrueNAS installations may advertise IPv6 DNS records even when the
 * container cannot complete an IPv6 connection. Discord interactions expire
 * after a few seconds, so waiting for an IPv6 connection to fall back to
 * IPv4 can make otherwise fast commands fail with error 10062.
 */
export function configureNetworkDefaults(): void {
  if (configured) {
    return;
  }

  setDefaultResultOrder('ipv4first');
  configured = true;
}
