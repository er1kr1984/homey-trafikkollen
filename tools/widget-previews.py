# Draws the widget preview images in the style of Athom's Figma "widget previews template" (card 896 px wide,
# radius 40, soft shadow, transparent canvas). Usage: python3 tools/widget-previews.py <out-dir>, then render each
# HTML file at 1024x1024 with a transparent background (e.g. headless Chromium --default-background-color=00000000).
import sys, math
out = sys.argv[1]
# Athom's template: card 896 wide at x=64, radius 40, soft shadow below, white / #1F2029, transparent canvas
X0, W = 64, 896
BLUE, PURPLE, GREEN, ORANGE, RED, TEAL = '#3b82c4', '#8b5cf6', '#30a46c', '#f5a524', '#e5484d', '#0891b2'

def theme(dark):
    return dict(card='#1F2029' if dark else '#FFFFFF', ink='#E6E6EE' if dark else '#2B2B35', mute='#4C4D5C' if dark else '#CDCDD8',
                soft='#2A2B37' if dark else '#F1F1F6', line='#33343F' if dark else '#ECECF2')

def bar(x, y, w, h, fill, r=None):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2 if r is None else r}" fill="{fill}"/>'

def page(height, body, c):
    y0 = (1024 - height) / 2
    return f'''<!doctype html><html><head><style>html,body{{margin:0;background:transparent}}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="20" stdDeviation="22" flood-color="#000" flood-opacity="0.07"/></filter>
<clipPath id="cardclip"><rect x="{X0}" y="{y0}" width="{W}" height="{height}" rx="40"/></clipPath></defs>
<rect x="{X0}" y="{y0}" width="{W}" height="{height}" rx="40" fill="{c['card']}" filter="url(#sh)"/>
<g clip-path="url(#cardclip)"><g transform="translate({X0} {y0})">{body}</g></g></svg></body></html>'''

def header(c, w1=300):
    return bar(48, 44, w1, 36, c['ink']) + bar(W - 48 - 110, 50, 110, 24, c['mute'])

# --- widgets (coordinates inside the card, card width 896) ---
def board(c):
    s = header(c)
    for i, (badge, l, t) in enumerate([(BLUE, 420, GREEN), (PURPLE, 360, None), (BLUE, 470, ORANGE), (PURPLE, 330, None)]):
        y = 130 + i * 112
        if i: s += f'<line x1="48" y1="{y-26}" x2="{W-48}" y2="{y-26}" stroke="{c["line"]}" stroke-width="3"/>'
        s += bar(48, y, 84, 48, badge, 12) + bar(156, y + 8, l, 32, c['ink']) + bar(156, y + 50, l * 0.55, 20, c['mute'])
        s += bar(W - 48 - 120, y + 4, 120, 40, c['ink']) + (bar(W - 48 - 90, y + 54, 90, 18, t) if t else '')
    return 580, s

def nearby(c):
    s = header(c, 260)
    y = 120
    for g in range(2):
        s += bar(48, y, 220, 26, c['mute']) ; y += 54
        for k, badge in enumerate([BLUE, GREEN] if g == 0 else [PURPLE, BLUE]):
            s += bar(48, y, 76, 44, badge, 12) + bar(148, y + 7, 380 - k * 60, 30, c['ink']) + bar(W - 48 - 110, y + 4, 110, 36, c['ink'])
            y += 76
        y += 24
    return 560, s

def commute(c):
    s = header(c, 340)
    for i, best in enumerate([True, False]):
        x = 48 + i * 412
        s += f'<rect x="{x}" y="116" width="388" height="170" rx="24" fill="{c["soft"]}"' + (f' stroke="{BLUE}" stroke-width="6"' if best else '') + '/>'
        s += bar(x + 28, 144, 150, 22, c['mute']) + bar(x + 28, 182, 170, 44, c['ink']) + bar(x + 28, 242, 260, 20, c['mute'])
    for i, (b1, b2) in enumerate([(GREEN, BLUE), (GREEN, PURPLE), (GREEN, BLUE)]):
        y = 340 + i * 112
        if i: s += f'<line x1="48" y1="{y-24}" x2="{W-48}" y2="{y-24}" stroke="{c["line"]}" stroke-width="3"/>'
        s += bar(48, y, 120, 40, c['ink']) + bar(48, y + 52, 90, 18, GREEN if i == 0 else c['mute'])
        s += bar(200, y + 2, 64, 36, b1, 10) + bar(280, y + 8, 220, 26, c['ink']) + bar(200, y + 50, 64, 30, b2, 10) + bar(280, y + 54, 260, 22, c['mute'])
        s += bar(W - 48 - 120, y, 120, 40, c['ink'])
    s += ''.join(f'<rect x="{48 + k*270}" y="690" width="246" height="56" rx="28" fill="{c["soft"]}"/><circle cx="{80 + k*270}" cy="718" r="11" fill="{[GREEN, GREEN, ORANGE][k]}"/>' + bar(104 + k*270, 708, 150, 20, c['ink']) for k in range(3))
    return 800, s

def leave(c):
    r = 120; circ = 2 * math.pi * r; cx, cy = 48 + r + 14, 120 + r + 14
    s = header(c, 280)
    s += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{c["soft"]}" stroke-width="30"/>'
    s += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{ORANGE}" stroke-width="30" stroke-linecap="round" stroke-dasharray="{circ:.1f}" stroke-dashoffset="{circ*0.62:.1f}" transform="rotate(-90 {cx} {cy})"/>'
    s += bar(cx - 56, cy - 44, 112, 70, c['ink'], 18) + bar(cx - 64, cy + 42, 128, 20, c['mute'])
    s += bar(400, 170, 220, 26, c['mute']) + bar(400, 222, 76, 44, BLUE, 12) + bar(496, 228, 300, 32, c['ink']) + bar(400, 292, 360, 24, c['mute'])
    s += f'<rect x="48" y="440" width="{W-96}" height="84" rx="20" fill="{ORANGE}" fill-opacity=".16"/>' + bar(80, 470, 560, 24, ORANGE)
    return 570, s

def cameras(c):
    s = ''
    tw, th = (W - 48*2 - 24) / 2, 220
    for i in range(4):
        x = 48 + (i % 2) * (tw + 24); y = 44 + (i // 2) * (th + 24)
        frame = RED if i == 1 else None
        s += f'<clipPath id="t{i}"><rect x="{x}" y="{y}" width="{tw}" height="{th}" rx="22"/></clipPath><g clip-path="url(#t{i})">'
        s += f'<rect x="{x}" y="{y}" width="{tw}" height="{th}" fill="{c["soft"]}"/>'
        s += f'<rect x="{x}" y="{y}" width="{tw}" height="{th*0.42}" fill="{BLUE}" fill-opacity=".28"/>'
        s += f'<path d="M{x+tw*0.30} {y+th} L{x+tw*0.47} {y+th*0.42} L{x+tw*0.55} {y+th*0.42} L{x+tw*0.78} {y+th} Z" fill="{c["mute"]}"/>'
        s += f'<path d="M{x+tw*0.53} {y+th} L{x+tw*0.51} {y+th*0.42} L{x+tw*0.515} {y+th*0.42} L{x+tw*0.56} {y+th} Z" fill="{ORANGE}"/>'
        s += bar(x + 20, y + th - 48, 170, 24, c['ink']) + '</g>'
        if frame:
            s += f'<rect x="{x+3}" y="{y+3}" width="{tw-6}" height="{th-6}" rx="20" fill="none" stroke="{frame}" stroke-width="8"/>' + bar(x + 20, y + 20, 200, 34, frame, 10)
    return 2 * th + 24 + 88, s

def ferry(c):
    s = header(c, 260)
    s += f'<rect x="48" y="116" width="{W-96}" height="72" rx="18" fill="{RED}" fill-opacity=".14"/>' + bar(80, 140, 480, 24, RED)
    for i in range(2):
        x = 48 + i * 412
        s += f'<rect x="{x}" y="216" width="388" height="296" rx="24" fill="{c["soft"]}"/>' + bar(x + 28, 244, 180, 22, c['mute'])
        for k in range(3):
            y = 292 + k * 70
            s += bar(x + 28, y, 130, 40, c['ink']) + bar(x + 388 - 28 - 110, y + 10, 110, 22, TEAL if k == 0 else c['mute'])
    return 560, s

def usage(c):
    s = header(c, 320)
    s += bar(48, 130, 380, 34, c['ink'])
    s += bar(48, 190, W - 96, 30, c['soft']) + bar(48, 190, (W - 96) * 0.58, 30, BLUE)
    for k, l in enumerate([300, 360, 420]):
        s += bar(48, 262 + k * 50, l, 24, c['mute'])
    return 460, s

for name, fn in dict(board=board, nearby=nearby, commute=commute, leave=leave, cameras=cameras, ferry=ferry, usage=usage).items():
    for th in ('light', 'dark'):
        c = theme(th == 'dark')
        h, body = fn(c)
        open(f'{out}/{name}-{th}.html', 'w').write(page(h, body, c))
print('ok')
