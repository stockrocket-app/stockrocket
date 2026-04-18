# Design System Strategy: The Hardware Nebula

## 1. Overview & Creative North Star

This design system is built upon the Creative North Star of **"The Kinetic Obsidian."** 

We are moving away from the flat, predictable layouts of standard SaaS and into a realm that feels high-performance, tactile, and proprietary. The aesthetic bridges the gap between sophisticated financial editorial and high-end hardware interfaces. By utilizing deep tonal shifts, glassmorphic layering, and vibrant neon accents, we create a technical environment that feels both authoritative and futuristic.

To break the "template" look, designers must embrace intentional asymmetry. Use large-scale typography that occasionally overlaps container boundaries and leverage varying surface depths to create a sense of physical machinery humming in a digital void.

---

## 2. Colors

The palette is anchored in deep shadows and punctuated by high-energy emerald signals.

### Tonal Foundations
*   **Background:** `#0e0e0e` (Deep Obsidian)
*   **Surface:** `#0e0e0e`
*   **Primary Accent:** `#00FFA3` (Neon Emerald)
*   **Secondary:** `#64fcc9` (Frosted Mint)
*   **Tertiary:** `#72dcff` (Electric Cyan)

### Critical Color Rules
*   **The "No-Line" Rule:** Do not use 1px solid borders to define major layout sections. Boundaries must be established through shifts in the surface tier (e.g., a `surface-container-low` hero section transitioning into a `surface` background).
*   **Surface Hierarchy & Nesting:** Treat the UI as layers of stacked glass. Use `surface-container-lowest` for deep background wells and `surface-container-highest` for elevated interactive panels. 
*   **The "Glass & Gradient" Rule:** Use semi-transparent surface colors with a `backdrop-blur` of 20px–40px for floating navigation or modal overlays.
*   **Signature Textures:** For primary actions, use a linear gradient transitioning from `primary` (`#b1ffce`) to `primary-container` (`#00ffa3`) at a 135-degree angle to give CTAs a "lit from within" hardware feel.

---

## 3. Typography

The typography strategy relies on the contrast between the technical precision of **Space Grotesk** and the modern readability of **Inter**.

*   **Display & Headlines (Space Grotesk):** These are your "Editorial Brute" elements. Use high-contrast weights (Bold/Medium) to command attention. Headlines should feel architectural.
*   **Body & Titles (Inter):** Used for functional data and descriptions. Inter provides a neutral, high-legibility counterpoint to the aggressive nature of the display type.
*   **Labels (Space Grotesk):** Small, all-caps labels provide a "system readout" feel, essential for the crypto-finance context.

---

## 4. Elevation & Depth

We eschew traditional drop shadows in favor of **Tonal Layering** and **Luminescence**.

*   **The Layering Principle:** Hierarchy is achieved by stacking tiers. An inner card should use `surface-container-highest` when placed on a `surface-container-low` section. This creates a soft, natural lift.
*   **Ambient Shadows:** If a floating element (like a dropdown) requires a shadow, use a 32px–64px blur at 6% opacity. The shadow color should be a tinted Emerald-Black (`#00100a`) to mimic the ambient glow of the primary accent.
*   **The "Ghost Border" Fallback:** If a container requires a border for accessibility, use the `outline-variant` token at 15% opacity. Never use 100% opaque borders.
*   **Hardware Glow:** Apply `glow-sm` (a subtle 4px–8px outer glow) to active states or critical status indicators using the `primary` token to simulate a physical LED.

---

## 5. Components

### Buttons
*   **Primary:** Pill-shaped (`rounding-full`), using the signature Emerald gradient. Text should be `on-primary` (Deep Green) for maximum punch.
*   **Secondary:** Glassmorphic fill with a "Ghost Border."
*   **Tertiary:** Text-only in `primary-fixed`, using `label-md` for a technical look.

### Input Fields
*   **Style:** Subtle `surface-container-highest` background. No bottom line; instead, use a 1px "Ghost Border" that illuminates to `primary` (100% opacity) on focus.
*   **Helper Text:** Always use `body-sm` in `on-surface-variant` to maintain a clean, editorial look.

### Cards & Lists
*   **The "No-Divider" Rule:** Explicitly forbid horizontal divider lines. Separate list items using `spacing-3` (vertical whitespace) or alternating tonal shifts between `surface-container-low` and `surface-container-lowest`.
*   **Rounding:** Apply `xl` (1.5rem / 24px) for outer containers and `lg` (1rem / 16px) for nested internal cards.

### Signature Component: The "Data Node"
For crypto-focused data, use small, high-contrast badges with `space-grotesk` labels. These should feature a subtle backdrop blur and a `primary` glow to highlight real-time price or status changes.

---

## 6. Do's and Don'ts

### Do
*   **DO** use ample white space (referencing the Spacing Scale) to let the high-tech elements breathe.
*   **DO** use "Space Grotesk" for numerical data to emphasize the technical nature of the platform.
*   **DO** apply `backdrop-blur` to any element that sits "above" the main content layer.

### Don't
*   **DON'T** use pure white (`#FFFFFF`) for large blocks of text; use `on-surface-variant` for body copy to reduce eye strain in dark mode.
*   **DON'T** use sharp 90-degree corners. Everything must feel machined and "soft-touch."
*   **DON'T** use standard grey shadows. If it glows, it glows green. If it casts a shadow, it casts a deep, emerald-tinted void.