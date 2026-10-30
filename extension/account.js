import { findElements } from './observations.js';

export async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Only account controls in the site's own navigation qualify. An author's avatar
// or a /user/ link in a feed is deliberately not a login signal.
export function accountRules(hostname) {
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(hostname)) return {
    signedIn: { testId: 'SideNav_AccountSwitcher_Button' },
    signedOut: { testId: 'loginButton' },
    identity: { testId: 'AppTabBar_Profile_Link' }
  };
  if (['youtube.com', 'www.youtube.com'].includes(hostname)) return {
    signedIn: { css: 'ytd-masthead #avatar-btn' },
    signedOut: { css: 'ytd-masthead a[href*="accounts.google.com/ServiceLogin"]' }
  };
  return {};
}

export function classifyAccount(signals) {
  if (Object.values(signals).some(s => s.ambiguous)) return 'unknown';
  if (signals.signedIn?.present && signals.signedOut?.present) return 'unknown';
  if (signals.signedIn?.present) return 'signed_in';
  if (signals.signedOut?.present) return 'signed_out';
  return 'unknown';
}

export async function readAccount(c, tabId, rules, guard) {
  const before = await c.page(tabId, 'identity');
  const url = new URL(before.url);
  const selected = rules || accountRules(url.hostname);
  const signals = {}, observations = {};
  for (const key of ['signedIn', 'signedOut', 'identity']) {
    if (!selected[key]) continue;
    const result = await findElements(c, tabId, { ...selected[key], frameId: 0 }, false, guard);
    const elements = result.elements.filter(e => e.visible);
    signals[key] = { present: elements.length === 1 && !result.truncated, ambiguous: elements.length > 1 || result.truncated };
    if (signals[key].present) observations[key] = elements[0];
  }
  guard();
  const after = await c.page(tabId, 'identity');
  if (before.token !== after.token || before.url !== after.url) throw new Error('ACCOUNT_PAGE_CHANGED: Read the current page again');
  const status = classifyAccount(signals);
  let account;
  const identity = observations.identity;
  if (status === 'signed_in' && identity && !['input', 'textarea', 'select'].includes(identity.tag) && identity.type !== 'password') {
    let key = identity.name?.trim();
    if (identity.href) {
      const href = new URL(identity.href, url);
      if (href.origin === url.origin && !/^\/(?:me|self|user(?:\/self)?|account|profile|settings|you)?\/?$/i.test(href.pathname)) key = href.pathname;
      else key = undefined;
    }
    if (/^(?:account(?: menu)?|my account|profile|my profile|user|个人资料|个人主页|账号|账户|我的|我)$/i.test(key || '')) key = undefined;
    if (key && key.length <= 160) account = { label: key, fingerprint: await fingerprint(url.origin + '\n' + key) };
  }
  const profile = await c.profile();
  const tab = await c.api.tabs.get(tabId);
  guard();
  if (tab.url !== after.url) throw new Error('ACCOUNT_PAGE_CHANGED: Read the current page again');
  return { profileId: profile.profileId, incognito: Boolean(tab.incognito), origin: url.origin, status, account: account || null, signals,
    source: rules ? 'observed_locators' : Object.keys(selected).length ? 'site_navigation' : 'no_site_rule',
    observedAt: new Date().toISOString(),
    note: 'Page evidence only. Cookies stay in Chrome and are not exported. signed_in does not identify a particular account unless account.fingerprint is present.' };
}
