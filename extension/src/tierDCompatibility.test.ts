import { describe, expect, it } from 'vitest';
import { activeXControlsInDesignerSource, peImageRequiresX86 } from './tierDCompatibility';

function pe32(options: { cli?: boolean; required32?: boolean }): Uint8Array {
  const bytes = Buffer.alloc(1024);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x014c, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x10b, optional);
  const section = optional + 0xe0;
  bytes.writeUInt32LE(0x200, section + 8);
  bytes.writeUInt32LE(0x2000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  if (options.cli) {
    bytes.writeUInt32LE(0x2000, optional + 96 + 14 * 8);
    bytes.writeUInt32LE(options.required32 ? 0x3 : 0x1, 0x200 + 16);
  }
  return bytes;
}

describe('Tier-D compatibility detection', () => {
  it('names AxInterop wrapper controls without matching unrelated Ax-prefixed user types', () => {
    const source = `
      private AxWMPLib.AxWindowsMediaPlayer player;
      private Acme.Controls.AxleControl axle;
      private AxShockwaveFlashObjects.AxShockwaveFlash flash;
    `;
    expect(activeXControlsInDesignerSource(source)).toEqual([
      { control: 'player', type: 'AxWMPLib.AxWindowsMediaPlayer' },
      { control: 'flash', type: 'AxShockwaveFlashObjects.AxShockwaveFlash' },
    ]);
  });

  // The shipped detector required the literal word `private`, a dotted type, one bare declarator and nothing else.
  // `Modifiers` is a first-class designer property, so flipping a field to public turned the whole Tier-D refusal
  // off and the form rendered with its ActiveX controls silently dropped. Every shape below returned [] before.
  it('refuses ActiveX regardless of modifier, declarator shape, namespace spelling or declaration site', () => {
    const shapes: Array<[string, string]> = [
      ['public', 'public AxWMPLib.AxWindowsMediaPlayer p;'],
      ['internal', 'internal AxWMPLib.AxWindowsMediaPlayer p;'],
      ['protected internal', 'protected internal AxWMPLib.AxWindowsMediaPlayer p;'],
      ['no modifier', 'AxWMPLib.AxWindowsMediaPlayer p;'],
      ['readonly', 'private readonly AxWMPLib.AxWindowsMediaPlayer p;'],
      ['static readonly', 'static readonly AxWMPLib.AxWindowsMediaPlayer p;'],
      ['field initializer', 'private AxWMPLib.AxWindowsMediaPlayer p = null;'],
      ['attributed', '[Browsable(false)]\nprivate AxWMPLib.AxWindowsMediaPlayer p;'],
      ['global::', 'private global::AxWMPLib.AxWindowsMediaPlayer p;'],
      ['unqualified under a using', 'using AxWMPLib;\nprivate AxWindowsMediaPlayer p;'],
      ['using alias', 'using Player = AxWMPLib.AxWindowsMediaPlayer;\nprivate Player p;'],
      ['construction site only', 'this.p = new AxWMPLib.AxWindowsMediaPlayer();'],
    ];
    for (const [label, source] of shapes) {
      expect(activeXControlsInDesignerSource(source).map((c) => c.control), label).toEqual(['p']);
    }
  });

  it('names every declarator, including a second on the same line and a back-to-back declaration', () => {
    expect(activeXControlsInDesignerSource('private AxWMPLib.AxWindowsMediaPlayer a, b;').map((c) => c.control))
      .toEqual(['a', 'b']);
    expect(activeXControlsInDesignerSource(
      'public AxWMPLib.AxWindowsMediaPlayer a; public AxWMPLib.AxWindowsMediaPlayer b;').map((c) => c.control))
      .toEqual(['a', 'b']);
  });

  it('recognizes a re-namespaced interop wrapper through the AxHost.State marker VS emits for every OCX', () => {
    const source = `
      private Interop.WMPLib.AxWindowsMediaPlayer player;
      this.player.OcxState = ((System.Windows.Forms.AxHost.State)(resources.GetObject("player.OcxState")));
    `;
    expect(activeXControlsInDesignerSource(source).map((c) => c.control)).toEqual(['player']);
  });

  // A false positive here is a permanent, unrecoverable refusal, so the widened detector must stay blind to
  // Ax-shaped text that is not a live declaration. An unqualified Ax name with no Ax `using` stays unbranded too.
  it('never brands commented-out code, string literals or unimported unqualified names', () => {
    const inert = [
      '/*\n private AxWMPLib.AxWindowsMediaPlayer ghost;\n*/\npublic System.Windows.Forms.Button b;',
      '// public AxWMPLib.AxWindowsMediaPlayer ghost;\nprivate System.Windows.Forms.Button b;',
      'this.label1.Text = "private AxWMPLib.AxWindowsMediaPlayer ghost;";',
      'private AxWindowsMediaPlayer p;',
      'private Acme.Axis axis;',
    ];
    for (const source of inert) expect(activeXControlsInDesignerSource(source), source).toEqual([]);
  });

  it('ignores literal #if false ActiveX code while retaining the live #else branch', () => {
    const inactive = `
      #if false
      private AxWMPLib.AxWindowsMediaPlayer ghost;
      #if true
      this.nested = new AxWMPLib.AxWindowsMediaPlayer();
      #endif
      #else
      private System.Windows.Forms.Button liveButton;
      #endif
    `;
    expect(activeXControlsInDesignerSource(inactive)).toEqual([]);

    const liveElse = inactive.replace('private System.Windows.Forms.Button liveButton;',
      'private AxWMPLib.AxWindowsMediaPlayer livePlayer;');
    expect(activeXControlsInDesignerSource(liveElse).map((control) => control.control)).toEqual(['livePlayer']);
  });

  it('distinguishes native/32BITREQUIRED x86 images from managed AnyCPU PE32 images', () => {
    expect(peImageRequiresX86(pe32({}))).toBe(true);
    expect(peImageRequiresX86(pe32({ cli: true, required32: true }))).toBe(true);
    expect(peImageRequiresX86(pe32({ cli: true, required32: false }))).toBe(false);
  });
});
