import path from 'node:path';
import { chromium, devices } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import type { AppConfig } from './config.js';

export const RESOURCE_KINDS = ['image', 'media', 'font', 'stylesheet'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

// Everything needed to (re)build one session's browser context.
export type ContextSpec = {
  headless: boolean;
  profile?: string;
  clonedFrom?: string;
  device?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  blockResources?: ResourceKind[];
  storageState?: StorageState;
};

const contextOptions = (spec: ContextSpec): BrowserContextOptions => {
  const options: BrowserContextOptions = {};
  if (spec.device) {
    const descriptor = devices[spec.device];
    if (!descriptor) {
      const examples = Object.keys(devices).filter((name) => !name.endsWith('landscape')).slice(-8).join('", "');
      throw new Error(`Unknown device "${spec.device}". Examples: "${examples}".`);
    }
    Object.assign(options, descriptor);
  }
  if (spec.viewport)
    options.viewport = spec.viewport;
  if (spec.userAgent)
    options.userAgent = spec.userAgent;
  if (spec.locale)
    options.locale = spec.locale;
  if (spec.timezoneId)
    options.timezoneId = spec.timezoneId;
  if (spec.storageState)
    options.storageState = spec.storageState;
  return options;
};

// One shared browser per mode (headless / headed). Sessions are contexts inside it,
// which is far lighter than a browser process per session. Profiles are the exception:
// a persistent profile needs its own browser process.
export class BrowserPool {
  private readonly shared = new Map<boolean, Promise<Browser>>();

  constructor(private readonly config: AppConfig) {}

  profileDir(profile: string): string {
    return path.join(this.config.dataDir, 'profiles', profile);
  }

  async newContext(spec: ContextSpec): Promise<BrowserContext> {
    const options = contextOptions(spec);
    const context = spec.profile
      ? await chromium.launchPersistentContext(this.profileDir(spec.profile), { ...this.launchOptions(spec.headless), ...options })
      : await (await this.sharedBrowser(spec.headless)).newContext(options);
    if (spec.blockResources?.length) {
      const blocked = new Set<string>(spec.blockResources);
      await context.route('**/*', (route) => (blocked.has(route.request().resourceType()) ? route.abort() : route.continue()));
    }
    return context;
  }

  async closeShared(headless: boolean): Promise<void> {
    const browser = this.shared.get(headless);
    this.shared.delete(headless);
    await browser?.then((b) => b.close()).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.shared.keys()].map((headless) => this.closeShared(headless)));
  }

  private launchOptions(headless: boolean): LaunchOptions {
    return { headless, channel: this.config.browser === 'chromium' ? undefined : this.config.browser };
  }

  private sharedBrowser(headless: boolean): Promise<Browser> {
    const existing = this.shared.get(headless);
    if (existing)
      return existing;
    const launching = chromium.launch(this.launchOptions(headless));
    this.shared.set(headless, launching);
    const forget = (): void => {
      if (this.shared.get(headless) === launching)
        this.shared.delete(headless);
    };
    launching.then((browser) => browser.on('disconnected', forget), forget);
    return launching;
  }
}
