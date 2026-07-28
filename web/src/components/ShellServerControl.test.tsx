/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FormEvent } from 'react';
import {
  ShellServerControl,
  getShellBridge,
  normalizeServerUrl,
  type BamFormShellBridge,
} from './ShellServerControl';

/**
 * The two contracts that matter:
 *  1. In a normal browser (no injected bridge) the control MUST NOT render —
 *     absent from the DOM, not hidden. The e2e/a11y suites run bridge-less
 *     and exercise exactly that path.
 *  2. Inside the shell (bridge present) it is a collapsed disclosure that
 *     pre-fills from the shell and hands a NORMALISED origin back to it.
 */

afterEach(() => {
  cleanup();
  delete window.BamFormShell;
});

describe('ShellServerControl — browser path (no bridge)', () => {
  it('renders nothing at all when window.BamFormShell is undefined', () => {
    const { container } = render(<ShellServerControl />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the injected object does not honour the contract', () => {
    window.BamFormShell = { getServerUrl: 'not-a-function' } as unknown as BamFormShellBridge;
    const { container } = render(<ShellServerControl />);
    expect(container).toBeEmptyDOMElement();
  });

  it('getShellBridge returns null without a bridge', () => {
    expect(getShellBridge()).toBeNull();
  });
});

describe('ShellServerControl — shell path (stubbed bridge)', () => {
  let setServerUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setServerUrl = vi.fn();
    window.BamFormShell = {
      getServerUrl: () => 'https://form.bevorasg.com',
      setServerUrl: setServerUrl as unknown as (url: string) => void,
    };
  });

  function expand() {
    fireEvent.click(screen.getByRole('button', { name: /server:/i }));
  }

  it('shows a collapsed disclosure naming the current server host', () => {
    render(<ShellServerControl />);
    const toggle = screen.getByRole('button', { name: /server:/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('form.bevorasg.com');
    // Collapsed means the field is not in the DOM.
    expect(screen.queryByLabelText('Server address')).not.toBeInTheDocument();
  });

  it('expands to a field pre-filled from getServerUrl()', () => {
    render(<ShellServerControl />);
    expand();
    expect(screen.getByRole('button', { name: /server:/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Server address')).toHaveValue('https://form.bevorasg.com');
  });

  it('confirming hands the shell a normalised origin', () => {
    render(<ShellServerControl />);
    expand();
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: '  192.168.4.20:8080/some/path  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    expect(setServerUrl).toHaveBeenCalledWith('http://192.168.4.20:8080');
    // While the shell probes, the control reports what happens next.
    expect(screen.getByRole('status')).toHaveTextContent(/reloads from it/i);
  });

  it('rejects an unusable address inline and never calls the bridge', () => {
    render(<ShellServerControl />);
    expand();
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'ftp://plant-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to this server' }));
    expect(setServerUrl).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid server address/i);
  });

  it('shows the no-HTTPS warning only for cleartext targets', () => {
    render(<ShellServerControl />);
    expand();
    const field = screen.getByLabelText('Server address');
    expect(screen.queryByText(/No HTTPS/)).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: '10.0.0.5' } });
    expect(screen.getByText(/No HTTPS/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'https://10.0.0.5' } });
    expect(screen.queryByText(/No HTTPS/)).not.toBeInTheDocument();
  });

  it('Enter in the field connects instead of submitting the sign-in form', () => {
    const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ShellServerControl />
      </form>,
    );
    expand();
    const field = screen.getByLabelText('Server address');
    fireEvent.change(field, { target: { value: 'https://plant.example' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(setServerUrl).toHaveBeenCalledWith('https://plant.example');
    expect(onSubmit).not.toHaveBeenCalled();
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
