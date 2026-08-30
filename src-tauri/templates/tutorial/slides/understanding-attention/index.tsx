import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { CSSProperties, ReactNode } from 'react';
import type { DesignSystem, Page, SlideMeta } from '@open-slide/core';

export const design: DesignSystem = {
  palette: {
    bg: '#fffdf8',
    text: '#29242d',
    accent: '#0087b2',
  },
  fonts: {
    display: '"STIX Two Text", "KaTeX_Main", Georgia, serif',
    body: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  typeScale: { hero: 104, body: 28 },
  radius: 14,
};

const C = {
  bg: '#fffdf8',
  ink: '#29242d',
  muted: '#716a74',
  blue: '#0087b2',
  blueBg: 'rgba(0, 135, 178, 0.08)',
  blueBorder: 'rgba(0, 135, 178, 0.25)',
  green: '#4d9a3e',
  greenBg: 'rgba(77, 154, 62, 0.08)',
  greenBorder: 'rgba(77, 154, 62, 0.25)',
  red: '#c9535b',
  redBg: 'rgba(201, 83, 91, 0.08)',
  redBorder: 'rgba(201, 83, 91, 0.25)',
  purple: '#6573c8',
  purpleBg: 'rgba(101, 115, 200, 0.08)',
  purpleBorder: 'rgba(101, 115, 200, 0.25)',
  display: '"STIX Two Text", "KaTeX_Main", Georgia, serif',
  body: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif',
};

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  position: 'relative',
  overflow: 'hidden',
  padding: '76px 92px 60px',
  background: C.bg,
  color: C.ink,
  fontFamily: C.body,
};

const Frame = ({ children }: { children: ReactNode }) => <div style={frameStyle}>{children}</div>;

const Pill = ({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'green' | 'red' | 'purple' }) => {
  const colors = {
    blue: { color: C.blue, background: C.blueBg, border: C.blueBorder },
    green: { color: C.green, background: C.greenBg, border: C.greenBorder },
    red: { color: C.red, background: C.redBg, border: C.redBorder },
    purple: { color: C.purple, background: C.purpleBg, border: C.purpleBorder },
  }[tone];
  return (
    <span
      style={{
        padding: '9px 18px',
        border: `1px solid ${colors.border}`,
        borderRadius: 999,
        background: colors.background,
        color: colors.color,
        fontSize: 18,
        fontWeight: 750,
        letterSpacing: '0.11em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
};

const Footer = ({ page }: { page: number }) => (
  <div
    style={{
      position: 'absolute',
      right: 60,
      bottom: 34,
      color: C.muted,
      fontSize: 18,
      letterSpacing: '0.08em',
    }}
  >
    {String(page).padStart(2, '0')} / 02
  </div>
);

const attentionFormula = katex.renderToString(
  String.raw`\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\!\left(\frac{QK^{\mathsf T}}{\sqrt{d_k}}\right)V`,
  { displayMode: true, throwOnError: false, strict: false },
);

const Cover: Page = () => (
  <Frame>
    <div
      style={{
        position: 'absolute',
        top: -250,
        right: -120,
        width: 620,
        height: 620,
        border: `1px solid ${C.blueBorder}`,
        borderRadius: '50%',
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: 170,
        bottom: -300,
        width: 560,
        height: 560,
        border: `1px solid ${C.redBorder}`,
        borderRadius: '50%',
      }}
    />
    <div style={{ display: 'flex', gap: 12 }}>
      <Pill>Lattice tutorial</Pill>
      <Pill tone="purple">Open Slide · React + TSX</Pill>
    </div>
    <div style={{ maxWidth: 1420, marginTop: 168 }}>
      <h1
        style={{
          margin: 0,
          fontFamily: C.display,
          fontSize: 126,
          fontWeight: 700,
          lineHeight: 0.98,
          letterSpacing: '-0.045em',
        }}
      >
        Understanding{' '}
        <span
          style={{
            background: `linear-gradient(135deg, ${C.blue} 0%, ${C.purple} 48%, ${C.red} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            fontStyle: 'italic',
          }}
        >
          attention
        </span>
      </h1>
      <p style={{ maxWidth: 980, margin: '38px 0 0', color: C.muted, fontSize: 34, lineHeight: 1.45 }}>
        A live research presentation you can inspect, revise with Agent, and present from Lattice.
      </p>
    </div>
    <div style={{ position: 'absolute', left: 92, bottom: 62, display: 'flex', gap: 12 }}>
      <Pill>Inspect</Pill>
      <Pill tone="green">Agent</Pill>
      <Pill tone="red">Present</Pill>
    </div>
    <Footer page={1} />
  </Frame>
);

const AttentionFlow: Page = () => (
  <Frame>
    <Pill>The core idea · query, key, value</Pill>
    <h2
      style={{
        maxWidth: 1260,
        margin: '28px 0 0',
        fontFamily: C.display,
        fontSize: 70,
        lineHeight: 1.08,
        letterSpacing: '-0.035em',
      }}
    >
      Let the query choose its context
    </h2>
    <p style={{ margin: '18px 0 0', color: C.muted, fontSize: 27 }}>
      Attention scores available signals, then mixes the most useful values.
    </p>
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 82px 1fr 82px 1fr',
        alignItems: 'center',
        marginTop: 76,
      }}
    >
      <div style={{ minHeight: 300, padding: '34px 38px', border: `1px solid ${C.blueBorder}`, borderLeft: `5px solid ${C.blue}`, borderRadius: 14, background: C.blueBg }}>
        <div style={{ color: C.blue, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>01 · QUERY</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Ask</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>What information matters right now?</p>
      </div>
      <div style={{ color: C.blue, fontFamily: C.display, fontSize: 54, textAlign: 'center' }}>→</div>
      <div style={{ minHeight: 300, padding: '34px 38px', border: `1px solid ${C.purpleBorder}`, borderLeft: `5px solid ${C.purple}`, borderRadius: 14, background: C.purpleBg }}>
        <div style={{ color: C.purple, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>02 · KEYS</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Score</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>Compare the query with every signal.</p>
      </div>
      <div style={{ color: C.red, fontFamily: C.display, fontSize: 54, textAlign: 'center' }}>→</div>
      <div style={{ minHeight: 300, padding: '34px 38px', border: `1px solid ${C.redBorder}`, borderLeft: `5px solid ${C.red}`, borderRadius: 14, background: C.redBg }}>
        <div style={{ color: C.red, fontSize: 18, fontWeight: 750, letterSpacing: '0.12em' }}>03 · VALUES</div>
        <h3 style={{ margin: '58px 0 14px', fontFamily: C.display, fontSize: 48 }}>Mix</h3>
        <p style={{ margin: 0, color: C.muted, fontSize: 25, lineHeight: 1.45 }}>Combine values using those weights.</p>
      </div>
    </div>
    <div
      style={{
        minHeight: 150,
        marginTop: 42,
        padding: '22px 34px',
        border: `1px solid ${C.greenBorder}`,
        borderRadius: 12,
        background: C.greenBg,
        display: 'grid',
        gridTemplateColumns: '290px 1fr',
        alignItems: 'center',
      }}
    >
      <div style={{ color: C.green, fontSize: 17, fontWeight: 750, lineHeight: 1.45, letterSpacing: '0.1em' }}>
        SCALED DOT-PRODUCT ATTENTION
      </div>
      <div
        aria-label="Attention of Q, K, and V equals softmax of Q K transpose over the square root of d k, times V"
        style={{ color: C.ink, fontSize: 42, textAlign: 'center' }}
        dangerouslySetInnerHTML={{ __html: attentionFormula }}
      />
    </div>
    <Footer page={2} />
  </Frame>
);

export const meta: SlideMeta = { title: 'Understanding attention' };
export const notes = [
  'Introduce the tutorial deck and explain that it is part of the research project.',
  'Connect query, key, and value to the accompanying tutorial manuscript.',
];
export default [Cover, AttentionFlow] satisfies Page[];
