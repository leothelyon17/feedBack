/**
 * INIT-002/SPEC-005 — targeted browser smoke for Auto visualization
 * selection and one mapping round trip.
 *
 * Live execution status for this spec dispatch: NOT RUN. The isolated
 * worker does not start Docker Compose / Chromium. Run it from the
 * feedBack repo after the app is reachable at http://localhost:8000:
 *
 *   npm run install:playwright
 *   LIBRARY_PATH=/path/to/library docker compose up -d
 *   npx playwright test tests/browser/drum-auto-viz-mapping.spec.ts
 *
 * What this records when executed:
 *   1. With the picker on Auto and a drum `songInfo` injected, Auto
 *      resolves to `drum_highway_3d` (WebGL2 + bundled plugin) and
 *      leaves `vizSelection` at `auto`.
 *   2. PUT /api/drums/kits/{id}/notes/{n} plus
 *      `feedBack.drumInput.notifyMappingChange` delivers one version-1
 *      mapping event describing the successful current mapping.
 */
import { test, expect } from '@playwright/test';

const SMOKE_KIT_ID = 'spec-005-auto-smoke';

test('Auto selects the 3D drum highway and one mapping round trip succeeds', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active', { timeout: 10000 });
  await page.waitForFunction(
    () => typeof (window as any).setViz === 'function'
      && typeof (window as any).feedBackViz_drum_highway_3d === 'function'
      && (window as any).feedBack
      && (window as any).feedBack.drumInput
      && (window as any).feedBack.drumInput.version === 1,
    { timeout: 15000 },
  );

  const autoResolution = await page.evaluate(() => {
    const w = window as any;
    const origGet = w.highway && w.highway.getSongInfo
      ? w.highway.getSongInfo.bind(w.highway)
      : () => ({});
    w.highway.getSongInfo = () => ({
      has_drum_tab: true,
      arrangement: 'Drums',
      arrangement_index: 0,
      arrangements: [{ index: 0, notes: 12 }],
    });
    try {
      const sel = document.getElementById('viz-picker') as HTMLSelectElement | null;
      if (sel) sel.value = 'auto';
      localStorage.setItem('vizSelection', 'auto');
      w.setViz('auto');
      const snap = w.feedBack.vizDomain && w.feedBack.vizDomain.snapshot
        ? w.feedBack.vizDomain.snapshot()
        : null;
      const autoOpt = sel && sel.querySelector('option[value="auto"]');
      return {
        pickerValue: sel ? sel.value : null,
        vizSelection: localStorage.getItem('vizSelection'),
        lastAutoMatch: snap && snap.lastAutoMatch,
        autoLabel: autoOpt ? autoOpt.textContent : null,
      };
    } finally {
      w.highway.getSongInfo = origGet;
    }
  });

  expect(autoResolution.pickerValue).toBe('auto');
  expect(autoResolution.vizSelection).toBe('auto');
  expect(autoResolution.lastAutoMatch).toBeTruthy();
  expect(autoResolution.lastAutoMatch.resolved).toBe('drum_highway_3d');
  expect(autoResolution.lastAutoMatch.matched).toBe(true);

  const putKit = await request.put(`/api/drums/kits/${SMOKE_KIT_ID}`, {
    data: {
      id: SMOKE_KIT_ID,
      name: 'SPEC-005 Auto smoke',
      manufacturer: 'feedBack',
      verified: false,
      notes: { '36': 'kick' },
      hihat: { pedal_cc: null, open: 'hh_open', closed: 'hh_closed', pedal: 'hh_pedal' },
    },
  });
  expect(putKit.ok(), `kit PUT failed: ${putKit.status()} ${await putKit.text()}`).toBeTruthy();

  const putNote = await request.put(`/api/drums/kits/${SMOKE_KIT_ID}/notes/38`, {
    data: { piece_id: 'snare' },
  });
  expect(putNote.ok(), `note PUT failed: ${putNote.status()} ${await putNote.text()}`).toBeTruthy();
  const mutationBody = await putNote.json();
  expect(mutationBody.mutation).toEqual({ midi_note: 38, operation: 'set', piece_id: 'snare' });
  expect(mutationBody.resolution).toEqual({ piece_id: 'snare', source: 'kit' });

  const mappingEvent = await page.evaluate(async ({ kitId }) => {
    const w = window as any;
    const seen: any[] = [];
    const off = w.feedBack.drumInput.subscribe((detail: any) => { seen.push(detail); });
    const notified = w.feedBack.drumInput.notifyMappingChange({
      kitId,
      mutation: 'set',
      midiNote: 38,
    });
    off();
    return { notified, seen };
  }, { kitId: SMOKE_KIT_ID });

  expect(mappingEvent.seen.length).toBe(1);
  expect(mappingEvent.seen[0].version).toBe(1);
  expect(mappingEvent.seen[0].mutation).toBe('set');
  expect(mappingEvent.seen[0].midiNote).toBe(38);
  expect(mappingEvent.seen[0].kitId).toBe(SMOKE_KIT_ID);
  expect(mappingEvent.notified.version).toBe(1);

  await request.delete(`/api/drums/kits/${SMOKE_KIT_ID}`);
});
