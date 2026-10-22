# Nova · Art direction

The bar: a site that could be featured on Awwwards (Site of the Day), and a live product demo that feels like the same studio made it. Think Lusion, Locomotive, Obys, Studio Freight, Active Theory, Apple product pages, but with the warmth of a family story instead of tech bravado.

## Concept: "The light in the kitchen"
Nova lives in a home. The interface should feel like looking into that home through a window at different hours: calm, warm, cinematic. Technology recedes; people and moments lead. Nova's signature is **light**: the soft cyan ring of an Echo that breathes when it listens, sweeps when it thinks, blooms when it speaks, and glows amber when the family needs to know something.

Mood: intimate · cinematic · calm · editorial · precise. Never "dashboard", never "hackathon template", never generic SaaS gradients.

## Palette (CSS custom properties)
```
--ink:      #0A0B10   night background
--ink-2:    #11131A   raised surfaces
--ink-3:    #191C26   cards on ink
--ivory:    #F4EEE6   primary text on dark, light sections background
--paper:    #EDE5D8   warm light surface
--mist:     rgba(244,238,230,.62)  secondary text
--faint:    rgba(244,238,230,.38)  tertiary
--line:     rgba(244,238,230,.10)  hairlines
--nova:     #3BD1FF   the light ring. Use as LIGHT (glow, bloom, thin strokes), rarely as a fill
--amber:    #FFB547   caregiver notification (Alexa's yellow ring)
--coral:    #FF6B57   urgent
--sage:     #9ED9B0   taken / steady
```
Time-of-day skies (used by the Studio ambient background and the landing "A day with Nova" section):
- dawn 06–08: `#F2A97E → #8D8FC4 → #2A2F55`
- day 08–16: `#BFDDF5 → #E9F2FB → #F6EFE6`
- golden 16–19: `#FFB27A → #E0708A → #4A3A7A`
- dusk 19–21: `#6B4C8F → #2B2850 → #12131F`
- night 21–06: `#0A0B10 → #121833 → #1B2347` with sparse stars

## Typography (Google Fonts)
- **Display:** `Instrument Serif` (regular + italic). Headlines, big numerals (the household clock), emotional words in italic ("speaks *first*"). Sizes `clamp(56px, 10vw, 184px)`, line-height .9, letter-spacing -0.02em.
- **Text/UI:** `Inter Tight` 400/500/600. Body 17–19px on the landing, 14–15px in the Studio.
- **Technical:** `JetBrains Mono` 400/500, 11–12px, uppercase, letter-spacing .12em for labels ("01 — SPEAKS FIRST", "MCP · TOOLS/CALL").
Pair big serif with tiny mono labels: that contrast is the signature typographic move.

## Layout
12-column grid, 24px gutters, max content 1440px, generous negative space. Oversized section indices (`01`, `02`…) in mono with a hairline. Asymmetric compositions; let images and devices bleed off the grid.

## Motion
- Easing: `cubic-bezier(.22, 1, .36, 1)` (expo-out) for reveals, 700–1100ms; springy micro-interactions 200–350ms.
- Text reveals: split into lines/words, masked, `translateY(110%) → 0`, 50–70ms stagger.
- Smooth scroll on the landing (Lenis). Scroll-driven scenes with GSAP ScrollTrigger (pinning, scrubbing).
- The light ring states: idle (faint), listening (breathing), thinking (sweeping arc), speaking (bloom pulse synced to speech), notification (amber pulse), urgent (coral).
- Always honour `prefers-reduced-motion` (no smooth scroll, no parallax, fades only).

## Texture & depth
- Film grain overlay (SVG `feTurbulence`, ~5% opacity, `mix-blend-mode: overlay`), soft vignette.
- Devices rendered with real depth: black glass bezels, inner screen glow, specular highlight, contact shadow, light from the ring spilling onto the surface below (blurred radial bloom).
- Subtle 3D tilt toward the cursor (perspective 1400px, max 4°) on hero devices.

## Signature interactions
- **Magnetic** buttons and chips; a custom cursor (small dot + lagging ring that grows over interactive elements) on the landing. In the Studio keep the native cursor over text inputs.
- **Marquee** of real Nova lines ("It's 6 PM, Rose. Time for your Metformin…", "Mom hasn't taken her 6 PM Metformin…").
- **Living sky**: in the Studio the background sky follows the household clock (time-lapse sweeps dawn → night, with a sun/moon on an arc and stars at night).
- **Curtain transition** from the landing into the Studio.

## Copy voice
Short, human, specific. Use the product's real lines and the real story (Rose, 81, Columbus; Maya, Seattle; Leo; Grace the aide; Dr. Patel; the lisinopril dose change). No buzzwords ("revolutionary", "AI-powered"), no emoji.

## Accessibility
WCAG AA contrast for text, visible focus rings (nova cyan), keyboard reachable controls, `aria-live` for spoken replies, reduced-motion fallback, and content readable with JavaScript disabled on the landing.
