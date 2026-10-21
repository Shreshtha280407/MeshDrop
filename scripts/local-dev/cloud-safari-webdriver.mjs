// Small W3C adapter for the receive-only native Safari cloud test. No extra SDK.
// Provider responses and credentials never enter errors or evidence.
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers/promises';

export async function connectNativeSafari(caps) {
  const authorization =
    'Basic ' +
    Buffer.from(`${caps['browserstack.username']}:${caps['browserstack.accessKey']}`).toString(
      'base64',
    );
  let session;
  async function command(path, body, method = 'POST') {
    try {
      const response = await globalThis.fetch(`https://hub.browserstack.com/wd/hub${path}`, {
        method,
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(90000),
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data.value?.error) throw new Error();
      return data.value;
    } catch {
      throw new Error('IOS_NATIVE_SAFARI_COMMAND_FAILED');
    }
  }
  const result = await command('/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'Safari',
        browserVersion: 'latest',
        'bstack:options': {
          os: caps.os,
          osVersion: caps.osVersion,
          userName: caps['browserstack.username'],
          accessKey: caps['browserstack.accessKey'],
          sessionName: caps.name,
          buildName: caps.build,
          video: false,
          debug: false,
          networkLogs: false,
        },
      },
    },
  });
  session = result.sessionId;
  if (!/^[a-f0-9]{40}$/.test(session ?? '')) throw new Error('IOS_NATIVE_SAFARI_SESSION_INVALID');
  const route = (path) => `/session/${session}${path}`;
  const execute = (script, args = []) => command(route('/execute/sync'), { script, args });
  const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
  function locator(find, argument, all = false) {
    const query = `(${find.toString()})(arguments[0])`;
    const value = async (expression) =>
      execute(`const element = ${query}; return ${expression};`, [argument]);
    async function element() {
      const found = await execute(`return ${query};`, [argument]);
      if (!/^[A-Za-z0-9-]+$/.test(found?.[elementKey] ?? ''))
        throw new Error('IOS_NATIVE_SAFARI_ELEMENT_UNAVAILABLE');
      return found[elementKey];
    }
    return {
      textContent: () => value('element?.textContent ?? null'),
      inputValue: () => value('element?.value ?? null'),
      allTextContents: () =>
        value(
          all
            ? '[...element].map(item => item.textContent)'
            : 'element ? [element.textContent] : []',
        ),
      isVisible: () =>
        value(
          'Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden")',
        ),
      async click() {
        await command(route(`/element/${await element()}/click`), {});
      },
      async fill(text) {
        const id = await element();
        await command(route(`/element/${id}/clear`), {});
        await command(route(`/element/${id}/value`), { text, value: [...text] });
      },
    };
  }
  const page = {
    goto: (url) => command(route('/url'), { url }),
    reload: () => command(route('/refresh'), {}),
    evaluate: (fn, argument) =>
      typeof argument === 'string' && argument.startsWith('browserstack_executor: ')
        ? execute(argument)
        : execute(`return (${fn.toString()})(arguments[0]);`, [argument ?? null]),
    locator: (selector) => ({
      ...locator((css) => globalThis.document.querySelector(css), selector),
      allTextContents: () =>
        locator(
          (css) => globalThis.document.querySelectorAll(css),
          selector,
          true,
        ).allTextContents(),
    }),
    getByRole(role, { name }) {
      if (role !== 'button') throw new Error('IOS_NATIVE_SAFARI_UNSUPPORTED_LOCATOR');
      return locator(
        (text) =>
          [...globalThis.document.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === text,
          ),
        name,
      );
    },
    getByLabel: (name) =>
      locator((text) => {
        const labels = [...globalThis.document.querySelectorAll('label')];
        const label = labels.find((item) => item.textContent?.trim() === text);
        return (
          label?.control ??
          [...globalThis.document.querySelectorAll('[aria-label]')].find(
            (item) => item.getAttribute('aria-label') === text,
          ) ??
          null
        );
      }, name),
    // Selenium has no Playwright download event. The caller must obtain actual
    // exported bytes through the documented provider executor before passing.
    waitForEvent: async () => {
      throw new Error('IOS_NATIVE_SAFARI_NO_DOWNLOAD_EVENT');
    },
  };
  return {
    nativeBrowser: {
      name: result.capabilities?.browserName,
      version: result.capabilities?.browserVersion,
      platform: result.capabilities?.platformName,
    },
    newContext: async () => ({ newPage: async () => page }),
    async nativeExport(name) {
      await execute('browserstack_executor: {"action":"saveFile"}').catch(() => {});
      for (let attempt = 0; attempt < 10; attempt++) {
        const data = await execute(
          `browserstack_executor: ${JSON.stringify({ action: 'getFileContent', arguments: { fileName: name } })}`,
        ).catch(() => null);
        if (typeof data === 'string' && /^[A-Za-z0-9+/\s]+=*$/.test(data)) return data;
        await setTimeout(1000);
      }
      return null;
    },
    async close() {
      if (!session) return;
      await command(route(''), undefined, 'DELETE');
      session = undefined;
    },
  };
}
