/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
import {
  ShellServerControl,
  getShellPort,
  normalizeServerUrl,
  SHELL_CHANNEL,
  SHELL_PROTOCOL_VERSION,
  type ShellMessagePort,
} from './ShellServerControl';

/**
 * The three contracts that matter:
 *
 *  1. In a normal browser (no injected port) the control MUST NOT render —
 *     absent from the DOM, not hidden. The e2e/a11y suites run port-less
 *     and exercise exactly that path.
 *  2. Inside the shell the transport is a WebMessageListener PORT, not a
 *     synchronous `addJavascriptInterface` object (review A-1/A-2: an
 *     injected interface reaches every frame and cannot express an origin
 *     rule). Everything is request/reply over that port.
 *  3. Switching servers strands the current origin's IndexedDB outbox
 *     (review W-1), so a switch with unsent rows requires an explicit,
 *     count-bearing confirmation.
 */

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>)[SHELL_CHANNEL];
});

interface FakePort extends ShellMessagePort {
  sent: string[];
  listenerCount(): number;
  emit(data: unknown): void;
  reply(payload: Record<string, unknown>): void;
  lastId(type: string): string;
}

/** Stands in for the object `WebViewCompat.addWebMessageListener` injects. */
function installPort(): FakePort {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const port: FakePort = {
    sent: [],
    postMessage(message: string) {
      port.sent.push(message);
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    emit(data: unknown) {
      act(() => {
        for (const listener of [...listeners]) listener({ data });
      });
    },
    reply(payload) {
      port.emit(JSON.stringify({ v: SHELL_PROTOCOL_VERSION, ...payload }));
    },
    lastId(type: string) {
      const match = port.sent
        .map((raw) => JSON.parse(raw) as { id: string; type: string })
        .filter((m) => m.type === type)
        .pop();
      if (!match) throw new Error(`no ${type} message was posted`);
      return match.id;
    },
  };
  (window as unknown as Record<string, unknown>)[SHELL_CHANNEL] = port;
  return port;
}

const noUnsent = () => Promise.resolve(0);

/** Render, hand back the shell's current origin, and expand the panel. */
async function mountOpen(
  port: FakePort,
  options: { url?: string; countUnsent?: () => Promise<number> } = {},
) {
  const view = render(
    <ShellServerControl countUnsent={options.countUnsent ?? noUnsent} />,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any;
  port.reply({
    id: port.lastId('getServerUrl'),
    type: 'serverUrl',
    url: options.url ?? 'https://form.bevorasg.com',
  });
  await screen.findByRole('button', { name: /server:/i });
  fireEvent.click(screen.getByRole('button', { name: /server:/i }));
  return view;
}

describe('ShellServerControl — browser path (no port)', () => {
  it('renders nothing at all when the shell channel is undefined', () => {
    const { container } = render(<ShellServerControl countUnsent={noUnsent} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the injected object does not honour the port contract', () => {
    // e.g. a leftover addJavascriptInterface-shaped object, or a page-script
    // impostor: no postMessage/addEventListener pair means no shell.
    (window as unknown as Record<string, unknown>)[SHELL_CHANNEL] = {
      getServerUrl: () => 'https://evil.example',
      setServerUrl: () => {},
    };
    const { container } = render(<ShellServerControl countUnsent={noUnsent} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('getShellPort returns null without a port', () => {
    expect(getShellPort()).toBeNull();
  });

  it('never touches IndexedDB in a browser', () => {
    const countUnsent = vi.fn(noUnsent);
    render(<ShellServerControl countUnsent={countUnsent} />);
    expect(countUnsent).not.toHaveBeenCalled();
  });
});

describe('ShellServerControl — shell path (message port)', () => {
  it('asks the shell for its origin on mount and renders nothing until it answers', async () => {
    const port = installPort();
    const { container } = render(<ShellServerControl countUnsent={noUnsent} />);
    // Nothing to name yet — the disclosure must not flash a blank host.
    expect(container).toBeEmptyDOMElement();
    const request = JSON.parse(port.sent[0]) as Record<string, unknown>;
    expect(request).toMatchObject({ v: SHELL_PROTOCOL_VERSION, type: 'getServerUrl' });
    expect(typeof request.id).toBe('string');

    port.reply({ id: request.id as string, type: 'serverUrl', url: 'https://form.bevorasg.com' });
    expect(await screen.findByRole('button', { name: /server:/i })).toHaveTextContent(
      'form.bevorasg.com',
    );
  });

  it('ignores replies that are not well-formed, not ours, or from another protocol', async () => {
    const port = installPort();
    render(<ShellServerControl countUnsent={noUnsent} />);
    port.emit(12345); // non-string
    port.emit('not json');
    port.emit(JSON.stringify({ v: 99, type: 'serverUrl', url: 'https://evil.example', id: 'x' }));
    port.reply({ id: 'someone-elses-id', type: 'serverUrl', url: 'https://evil.example' });
    expect(screen.queryByRole('button', { name: /server:/i })).not.toBeInTheDocument();

    port.reply({
      id: port.lastId('getServerUrl'),
      type: 'serverUrl',
      url: 'https://form.bevorasg.com',
    });
    expect(await screen.findByRole('button', { name: /server:/i })).toHaveTextContent(
      'form.bevorasg.com',
    );
  });

  it('expands to a field pre-filled with the shell origin', async () => {
    const port = installPort();
    await mountOpen(port);
    expect(screen.getByRole('button', { name: /server:/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Server address')).toHaveValue('https://form.bevorasg.com');
  });

  it('posts a normalised origin over the port when nothing is unsent', async () => {
    const port = installPort();
    await mountOpen(port);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: '  192.168.4.20:8080/some/path  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));

    await waitFor(() => expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(true));
    const message = JSON.parse(port.sent[port.sent.length - 1]) as Record<string, unknown>;
    expect(message).toMatchObject({
      v: SHELL_PROTOCOL_VERSION,
      type: 'setServerUrl',
      url: 'http://192.168.4.20:8080',
    });
    expect(screen.getByRole('status')).toHaveTextContent(/reloads from it/i);
  });

  it('rejects an unusable address inline and never posts', async () => {
    const port = installPort();
    await mountOpen(port);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'ftp://plant-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/valid server address/i),
    );
    expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(false);
  });

  it('shows the no-HTTPS warning only for cleartext targets', async () => {
    const port = installPort();
    await mountOpen(port);
    const field = screen.getByLabelText('Server address');
    expect(screen.queryByText(/No HTTPS/)).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: '10.0.0.5' } });
    expect(screen.getByText(/No HTTPS/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'https://10.0.0.5' } });
    expect(screen.queryByText(/No HTTPS/)).not.toBeInTheDocument();
  });

  it('Enter in the field connects instead of submitting the sign-in form', async () => {
    const port = installPort();
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ShellServerControl countUnsent={noUnsent} />
      </form>,
    );
    port.reply({
      id: port.lastId('getServerUrl'),
      type: 'serverUrl',
      url: 'https://form.bevorasg.com',
    });
    fireEvent.click(await screen.findByRole('button', { name: /server:/i }));
    const field = screen.getByLabelText('Server address');
    fireEvent.change(field, { target: { value: 'https://plant.example' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(true));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('surfaces a native switch failure inline and re-arms the button (review W-2)', async () => {
    const port = installPort();
    await mountOpen(port);
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://dead.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    port.reply({
      id: port.lastId('setServerUrl'),
      type: 'switchResult',
      ok: false,
      error: 'That server did not respond.',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('That server did not respond.');
    // Re-armed by the OUTCOME, not by a timer unrelated to it.
    expect(screen.getByRole('button', { name: 'Connect to this server' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ShellServerControl — unsent work is not silently stranded (review W-1)', () => {
  it('warns with the count and does not post until the switch is confirmed', async () => {
    const port = installPort();
    await mountOpen(port, { countUnsent: () => Promise.resolve(3) });
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://plant-b.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));

    const warning = await screen.findByRole('alertdialog');
    expect(warning).toHaveTextContent(/3 unsent records/i);
    expect(warning).toHaveTextContent('form.bevorasg.com');
    expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /switch anyway/i }));
    await waitFor(() => expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(true));
    expect(JSON.parse(port.sent[port.sent.length - 1])).toMatchObject({
      type: 'setServerUrl',
      url: 'https://plant-b.example',
    });
  });

  it('uses singular copy for one record and abandons the switch on cancel', async () => {
    const port = installPort();
    await mountOpen(port, { countUnsent: () => Promise.resolve(1) });
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://plant-b.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/1 unsent record\b/i);
    fireEvent.click(screen.getByRole('button', { name: /keep this server/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(false);
  });

  it('warns rather than switching when the outbox cannot be read', async () => {
    const port = installPort();
    await mountOpen(port, { countUnsent: () => Promise.reject(new Error('idb blocked')) });
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://plant-b.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    // Unknown is not the same as zero: an unreadable outbox must not be
    // reported as "nothing at stake" for an ISO-13485 record system.
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/could not be checked/i);
    expect(port.sent.some((m) => m.includes('setServerUrl'))).toBe(false);
  });

  it('counts the whole origin against the CURRENT server, not the typed one', async () => {
    const port = installPort();
    const countUnsent = vi.fn(() => Promise.resolve(2));
    await mountOpen(port, { url: 'http://10.0.0.7:8080', countUnsent });
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://plant-b.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('10.0.0.7:8080');
    expect(countUnsent).toHaveBeenCalledTimes(1);
  });
});

describe('ShellServerControl — lifecycle hygiene', () => {
  it('detaches its port listener on unmount', async () => {
    const port = installPort();
    const { unmount } = await mountOpen(port);
    expect(port.listenerCount()).toBe(1);
    unmount();
    expect(port.listenerCount()).toBe(0);
  });

  it('reads the origin from state, not by re-querying the port on every render', async () => {
    const port = installPort();
    await mountOpen(port);
    const before = port.sent.length;
    fireEvent.click(screen.getByRole('button', { name: /server:/i })); // collapse
    fireEvent.click(screen.getByRole('button', { name: /server:/i })); // expand
    expect(port.sent.length).toBe(before);
  });
});

describe('normalizeServerUrl — mirror of the shell-native rules', () => {
  it.each([
    ['https://form.bevorasg.com', 'https://form.bevorasg.com'],
    ['https://form.bevorasg.com/', 'https://form.bevorasg.com'],
    ['https://Form.Bevorasg.com/path?q=1', 'https://form.bevorasg.com'],
    ['192.168.4.20', 'http://192.168.4.20'],
    ['192.168.4.20:8080', 'http://192.168.4.20:8080'],
    ['http://10.1.2.3:3000/deep/link', 'http://10.1.2.3:3000'],
    ['  https://x.local  ', 'https://x.local'],
  ])('normalises %s → %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['ftp://host'],
    ['javascript:alert(1)'],
    ['http://user:pass@host'],
    ['http://'],
    ['a'.repeat(2001)],
  ])('rejects %s', (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});
