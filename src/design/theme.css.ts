import { css } from '@a11d/lit'
import { contrastColorOf } from './contrastColor.js'

/** The palette every surface derives from. The website emits this block verbatim, so it holds no app behaviour. */
export const themeStyles = css`
	:root {
		color-scheme: light dark;
		--color-background-seed: color-mix(in srgb, light-dark(#f1f3f4, #121314), var(--color-accent) 2.5%);
		--color-background: var(--color-background-seed);
		--color-surface: color-mix(in srgb, light-dark(#ffffff, #191a1b), var(--color-accent) 5%);
		--color-text: color-mix(in srgb, light-dark(black, white), var(--color-accent) 2.5%);
		--color-text-muted: color-mix(in srgb, var(--color-text), var(--color-background) 45%);
		--color-error: light-dark(#d1453b, #e5675e);
		--color-success: light-dark(#2e8540, #5cbf75);
		--color-accent: light-dark(black, white);
		${contrastColorOf('--color-accent-text', 'var(--color-accent)')};
		--color-border: var(--color-surface);
		--border: 1px solid var(--color-border);
		--border-radius: 4px;
		--font-family: 'Inter Variable', 'Vazirmatn Variable', sans-serif;

		&[data-theme=light] {
			color-scheme: light;
		}

		&[data-theme=dark] {
			color-scheme: dark;
		}

		/* White paper, black ink: every block stays neutral and only the narrow source marker carries color.
		   Event segments read these fills through --entry-color-fill / --entry-card-base (EventSegment). */
		&[data-theme=minimalist] {
			color-scheme: light;
			--color-background-seed: #ffffff;
			--color-background: #ffffff;
			--color-surface: #ffffff;
			--color-text: #111111;
			/* 5.7:1 on white; the palette's 45% mix would land below the 4.5:1 floor. */
			--color-text-muted: #666666;
			--entry-color-fill: 0%;
			--entry-color-fill-hover: 8%;
			--entry-card-base: color-mix(in srgb, #111111 4%, #ffffff);
		}
	}

	/* Han characters read in Noto Sans SC only while the app speaks Chinese: a Japanese heading elsewhere keeps its own glyphs. */
	body:lang(zh) {
		--font-family: 'Inter Variable', 'Noto Sans SC Variable', sans-serif;
	}
`
