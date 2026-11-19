/**
 * screen — fixed browser screen size (default 1360x768) for Camoufox.
 *
 * Camofox-browser starts Xvfb at 1280x720 and lets Camoufox pick a random device
 * screen for the browser window, so the page ends up clipped to the display or
 * bigger than it. This plugin pins both to one number: the Xvfb `-screen`
 * argument and the window/screen numbers Camoufox reads from CAMOU_CONFIG_*.
 *
 * Enabled from camofox.config.json:
 *   "plugins": { "screen": { "enabled": true, "resolution": "1360x768" } }
 *
 * The manager overrides it with SCREEN_RESOLUTION (VNC_RESOLUTION when the browser
 * is shown over VNC). When the vnc plugin is enabled it owns the display, so this
 * plugin only follows its resolution — two virtual-display providers for the same
 * capability would abort the server.
 */

import { removeXvfbDisplayFiles } from '../../lib/tmp-cleanup.js';

const DEFAULT_RESOLUTION = '1360x768';

function normalize(raw) {
    const m = /^(\d{3,4})x(\d{3,4})(?:x(\d{2}))?$/.exec(String(raw || '').trim());
    if (!m) return null;
    return `${Number(m[1])}x${Number(m[2])}x${m[3] || '24'}`;
}

export function register(app, ctx, settings = {}) {
    const log = ctx.log;
    const vncOn = process.env.ENABLE_VNC === '1' || ctx.config?.plugins?.vnc?.enabled === true;
    const vncConfig = ctx.config?.plugins?.vnc || {};
    const requested = vncOn
        ? (process.env.VNC_RESOLUTION || vncConfig.resolution || process.env.SCREEN_RESOLUTION || settings.resolution)
        : (process.env.SCREEN_RESOLUTION || settings.resolution);
    const resolution = normalize(requested) || DEFAULT_RESOLUTION;
    const [width, height] = resolution.split('x').map(Number);

    if (!vncOn) {
        class ScreenVirtualDisplay extends ctx.VirtualDisplay {
            get xvfb_args() {
                const args = super.xvfb_args;
                const idx = args.indexOf('0');
                if (idx > 0 && args[idx - 1] === '-screen') {
                    const patched = [...args];
                    patched[idx + 1] = resolution;
                    return patched;
                }
                return args;
            }

            kill() {
                const proc = this.proc;
                if (!proc || this.cleanedUp) return super.kill();
                this.cleanedUp = true;
                const cleanup = () => removeXvfbDisplayFiles(this.display);
                if (proc.exitCode === null) proc.once('exit', cleanup);
                else cleanup();
                return super.kill();
            }
        }
        ctx.plugin.registerVirtualDisplayProvider(() => new ScreenVirtualDisplay());
    }

    // Camoufox takes the window/screen numbers from the CAMOU_CONFIG_* env vars
    // (its Firefox build sizes the real window from window.outerWidth/Height),
    // and camofox filled them from a randomly chosen device screen — which is why
    // the page came out 1920x1080 on a 1360x768 display. Rewriting that config is
    // the only working lever: camofox creates Playwright contexts with
    // viewport: null, Playwright's viewport emulation is Chromium-only
    // (Browser.setDefaultViewport is rejected by the Firefox driver), and so is
    // camofox's POST /tabs/:id/viewport endpoint.
    ctx.events.on('browser:launching', ({ options }) => {
        const env = options.env;
        if (!env) return;
        const names = Object.keys(env)
            .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
            .sort((a, b) => Number(a.split('_')[2]) - Number(b.split('_')[2]));
        if (!names.length) {
            log('warn', 'screen: CAMOU_CONFIG tidak ditemukan, ukuran jendela tidak diubah');
            return;
        }
        let cfg;
        try {
            cfg = JSON.parse(names.map((n) => env[n]).join(''));
        } catch (err) {
            log('warn', 'screen: konfigurasi camoufox tidak terbaca, ukuran jendela tidak diubah', { error: err.message });
            return;
        }
        Object.assign(cfg, {
            'screen.width': width,
            'screen.height': height,
            'screen.availWidth': width,
            'screen.availHeight': height,
            'window.outerWidth': width,
            'window.outerHeight': height,
            'window.screenX': 0,
            'window.screenY': 0,
        });
        // Same chunking camoufox-js uses (environment variables are size-limited).
        const chunkSize = process.platform === 'win32' ? 2047 : 32767;
        const json = JSON.stringify(cfg);
        names.forEach((n) => delete env[n]);
        for (let i = 0, part = 1; i < json.length; i += chunkSize, part += 1) {
            env[`CAMOU_CONFIG_${part}`] = json.slice(i, i + chunkSize);
        }
    });

    log('info', 'screen: resolusi layar browser', { resolution, vnc: vncOn });
}
