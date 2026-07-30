// Honest backend selection for the AT-SPI automation layer — mirrors
// ../backend.ts's resolveBackend() and ../browser/resolve.ts's
// resolveBrowserBackend(). Priority: explicit SIRA_ATSPI_BACKEND override
// (fake, for every test in this repo's own suite) > probe the real
// dependencies and report readiness honestly, never a crash and never a
// silent pretend-success. Both probes are quick spawnSync checks — same
// style as ../backends/gnome-wayland.ts's probeExtension() — deliberately
// NOT spawning the persistent helper just to check readiness.
import { spawnSync } from 'node:child_process';
import { RealAtspiBackend } from './backend.ts';
import type { ResolvedAtspiBackend } from './backend.ts';

function atspiImportable(): boolean {
  try {
    const result = spawnSync(
      'python3',
      ['-c', "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"],
      { stdio: 'ignore', timeout: 3000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function accessibilityEnabled(): boolean {
  try {
    const result = spawnSync(
      'gsettings', ['get', 'org.gnome.desktop.interface', 'toolkit-accessibility'],
      { encoding: 'utf8', timeout: 2000 },
    );
    return result.status === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function resolveAtspiBackend(): Promise<ResolvedAtspiBackend> {
  const forced = process.env.SIRA_ATSPI_BACKEND;
  if (forced === 'fake') {
    const { FakeAtspiBackend } = await import('./backends/fake.ts');
    return { backend: new FakeAtspiBackend(), kind: 'fake', ready: true, reason: 'SIRA_ATSPI_BACKEND=fake', dependencies: {} };
  }

  const importable = atspiImportable();
  const accessible = accessibilityEnabled();
  const ready = importable && accessible;

  let reason: string;
  if (ready) {
    reason = 'AT-SPI available and accessibility enabled';
  } else if (!importable && !accessible) {
    reason = 'AT-SPI GObject-Introspection bindings not importable, and org.gnome.desktop.interface toolkit-accessibility is not enabled';
  } else if (!importable) {
    reason = "AT-SPI GObject-Introspection bindings not importable — install this distro's gir1.2-atspi-2.0 (or equivalent) package";
  } else {
    reason = 'org.gnome.desktop.interface toolkit-accessibility is not enabled — enable it via GNOME Settings > Accessibility, or `gsettings set org.gnome.desktop.interface toolkit-accessibility true`';
  }

  return {
    backend: new RealAtspiBackend(),
    kind: 'atspi',
    ready,
    reason,
    dependencies: { atspiImportable: importable, accessibilityEnabled: accessible },
  };
}
