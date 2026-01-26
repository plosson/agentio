# Me Inc. Design System

This document contains the design guidelines, colors, typography, and component patterns for Me Inc. Use this as a reference when building new features or modifying existing UI to maintain visual consistency.

The **Alpine theme** (located in `worker/public/alpine/`) serves as the reference implementation for this design system. All patterns and examples in this document are taken from the Alpine theme.

---

## 1. Typography

### Font Families
- **Primary (Sans-serif):** `IBM Plex Sans` - Used for all body text and UI elements
- **Monospace:** `IBM Plex Mono` - Used for code, technical identifiers, cron expressions, and log output

**CDN Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
```

### Font Sizes
| Size | Value | Usage |
|------|-------|-------|
| `h1` | 1.75rem (28px) | Page titles |
| `h2` | 1.375rem (22px) | Section headers |
| `h3` | 1.125rem (18px) | Subsection headers |
| `h4` | 1rem (16px) | Card titles, inline headers |
| `text-base` | 1rem (16px) | Body text |
| `text-sm` | 0.875rem (14px) | Secondary text, buttons, form inputs |
| `text-xs` | 0.8125rem (13px) | Meta information, hints, captions |
| Badge text | 0.75rem (12px) | Status badges |

### Font Weights
| Weight | Value | Usage |
|--------|-------|-------|
| `font-weight: 600` | Semibold | Headings, card titles, labels, buttons |
| `font-weight: 500` | Medium | Active states, form labels |
| `font-weight: 400` | Normal | Body text, descriptions |

### Line Heights
- Body text: `1.6`
- Headings: `1.3`
- Buttons/inputs: `1`

---

## 2. Color Palette

### CSS Custom Properties (Light Mode - Default)
```css
:root {
  /* Backgrounds */
  --bg: #f8f9fa;           /* Page background */
  --surface: #ffffff;       /* Cards, panels, modals */
  --code-bg: #f6f8fa;      /* Code blocks, muted backgrounds */

  /* Borders */
  --border: #d1d9e0;        /* Primary borders */
  --border-light: #e8ecf0;  /* Subtle dividers */

  /* Text */
  --text: #1f2328;          /* Primary text */
  --text-secondary: #656d76; /* Secondary/descriptive text */
  --text-muted: #8b949e;    /* Placeholder, disabled, hints */

  /* Accent (Primary action color) */
  --accent: #0969da;        /* Links, primary buttons */
  --accent-hover: #0860ca;  /* Hover state */
  --accent-bg: #ddf4ff;     /* Accent backgrounds (selected states) */

  /* Status Colors */
  --success: #1a7f37;
  --success-bg: #dafbe1;
  --warning: #9a6700;
  --warning-bg: #fff8c5;
  --error: #cf222e;
  --error-bg: #ffebe9;
}
```

### Dark Mode (via `skins/dark.css`)
```css
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --border-light: #21262d;
  --text: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --accent: #58a6ff;
  --accent-hover: #79c0ff;
  --accent-bg: rgba(56, 139, 253, 0.15);
  --success: #3fb950;
  --success-bg: rgba(46, 160, 67, 0.15);
  --warning: #d29922;
  --warning-bg: rgba(187, 128, 9, 0.15);
  --error: #f85149;
  --error-bg: rgba(248, 81, 73, 0.15);
  --code-bg: #0d1117;
}
```

### Shadows
```css
--shadow: 0 1px 3px rgba(31, 35, 40, 0.04);     /* Subtle elevation */
--shadow-md: 0 3px 6px rgba(31, 35, 40, 0.08); /* Dropdowns, modals */
```

---

## 3. Spacing & Layout

### Border Radius
| Token | Value | Usage |
|-------|-------|-------|
| `--radius` | 8px | Buttons, inputs, cards, badges |
| `--radius-lg` | 12px | Large cards, modals |
| `4px` | - | Inline code, small badges |
| `20px` | - | Pill-shaped badges |
| `50%` | - | Avatars, circular elements |

### Spacing Scale
- 0.25rem (4px) - Tight gaps
- 0.5rem (8px) - Small gaps, badge padding
- 0.75rem (12px) - Card meta gaps
- 1rem (16px) - Section spacing, card padding
- 1.5rem (24px) - Large section spacing
- 2rem (32px) - Main content padding
- 3rem (48px) - Empty state padding
- 4rem (64px) - Main vertical padding

### Layout Structure

#### Standard Page (Dashboard)
```
┌─────────────────────────────────────────────────┐
│  Header (64px height, sticky)                   │
│  ┌─────────────────────────────────────────┐    │
│  │ Logo │ Workspace Selector │ User Menu   │    │
│  └─────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  Main Content (.container max-width: 900px)     │
│  - Section headers with actions                 │
│  - Grid of cards                                │
└─────────────────────────────────────────────────┘
```

#### Workspace/Agent Page (Sidebar Layout)
```
┌──────────────────────────────────────────────────────────┐
│  Header (64px height, sticky)                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Hamburger │ Logo │ Workspace Selector │ User Menu  │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────┬───────────────────────────────────────────┤
│  Sidebar     │  Main Content (.app-main)                 │
│  (240px)     │  max-width: 800px                         │
│  ┌────────┐  │  ┌───────────────────────────────────┐    │
│  │ Agents │  │  │ Page header + actions             │    │
│  │ ─────  │  │  ├───────────────────────────────────┤    │
│  │ Item 1 │  │  │ Content cards                     │    │
│  │ Item 2 │  │  │                                   │    │
│  │ + Add  │  │  │                                   │    │
│  ├────────┤  │  │                                   │    │
│  │ Tools  │  │  └───────────────────────────────────┘    │
│  │ ─────  │  │                                           │
│  │ History│  │                                           │
│  │ Secrets│  │                                           │
│  │ etc.   │  │                                           │
│  └────────┘  │                                           │
└──────────────┴───────────────────────────────────────────┘
```

### Key Dimensions
| Element | Size |
|---------|------|
| Header height | 64px (56px on mobile) |
| Sidebar width | 240px |
| Container max-width | 900px (dashboard), 800px (app-main) |
| Button height | ~38px (padding-based) |
| Input height | ~38px (padding-based) |
| Card padding | 1.25rem (20px) |

---

## 4. Icons

### Icon Approach
Me Inc. uses **inline SVG icons** rather than an icon font library. Icons are embedded directly in HTML with `viewBox="0 0 16 16"` or `viewBox="0 0 24 24"`.

### Icon Sizing
```html
<!-- 16x16 (small, inline with text) -->
<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">...</svg>

<!-- 24x24 (logo, hamburger menu) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">...</svg>
```

### Common Icons
| Usage | Description |
|-------|-------------|
| Logo | Stacked layers (stroke-based) |
| Chevron down | Dropdown indicators |
| Plus | Add/create actions |
| Play | Run action |
| Pencil | Edit action |
| Trash | Delete action |
| Hamburger | Mobile menu toggle |
| External link | External navigation |
| Caret right | Expandable items |

### Icon Style Guidelines
- Use `fill="currentColor"` to inherit text color
- Stroke icons use `stroke="currentColor"` with `stroke-width="2"`
- Icons in buttons should have 0.5rem gap from text
- Sidebar icons: 16x16
- Button icons: 16x16 or 14x14

---

## 5. Logo

The Me Inc. logo is a simple stroke-based SVG depicting stacked layers:

```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
</svg>
```

### Logo Usage
- Header: 28x28px with "Me Inc." text
- Text follows immediately after icon with 0.5rem gap
- Logo links to dashboard (`dashboard.html`)

### Logo + Title Style
```css
.header-logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 1.125rem;
  color: var(--text);
  text-decoration: none;
}
```

---

## 6. Component Styles

### Buttons

#### Variants
| Variant | Class | Background | Text | Border |
|---------|-------|------------|------|--------|
| Primary | `.btn-primary` | `--accent` | white | `--accent` |
| Secondary | `.btn-secondary` | `--surface` | `--text` | `--border` |
| Danger | `.btn-danger` | `--surface` | `--error` | `--border` |
| Ghost | `.btn-ghost` | transparent | `--text-secondary` | transparent |

#### Base Styles
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1;
  border-radius: var(--radius);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

#### Sizes
| Size | Class | Padding |
|------|-------|---------|
| Default | `.btn` | 0.625rem 1rem |
| Small | `.btn-sm` | 0.375rem 0.625rem |
| Icon only | `.btn-icon` | 0.5rem |

### Form Inputs

```css
.form-input, .form-select, .form-textarea {
  display: block;
  width: 100%;
  padding: 0.625rem 0.75rem;
  font-family: inherit;
  font-size: 0.875rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: all 0.15s ease;
}

.form-input:focus, .form-select:focus, .form-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}
```

### Form Groups
```css
.form-group { margin-bottom: 1.25rem; }

.form-label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
  color: var(--text);
}

.form-hint {
  font-size: 0.8125rem;
  color: var(--text-muted);
  margin-top: 0.375rem;
}
```

### Cards

```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  transition: all 0.15s ease;
}

.card-link:hover .card {
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.25rem;
}

.card-description {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
```

### Status Badges

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 20px;
}

.badge-success { background: var(--success-bg); color: var(--success); }
.badge-warning { background: var(--warning-bg); color: var(--warning); }
.badge-error { background: var(--error-bg); color: var(--error); }
.badge-neutral { background: var(--code-bg); color: var(--text-secondary); }
```

### Sidebar

```css
.app-sidebar {
  width: 240px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  position: sticky;
  top: 64px;
  height: calc(100vh - 64px);
}

.sidebar-header {
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem 0.5rem 1.5rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.sidebar-item:hover {
  background: var(--code-bg);
  color: var(--text);
}

.sidebar-item.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 500;
}
```

### Tables

```css
.table-wrapper {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th, td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--border-light);
}

th {
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--code-bg);
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

tr:hover td { background: var(--code-bg); }
```

### Banners/Alerts

```css
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
  margin-bottom: 1.5rem;
}

.banner-warning {
  background: var(--warning-bg);
  color: var(--warning);
  border: 1px solid #e3b341;
}

.banner-info {
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid #80ccff;
}
```

### Toast Notifications

```css
.toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%) translateY(100%);
  background: var(--text);
  color: white;
  padding: 0.875rem 1.25rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
  box-shadow: var(--shadow-md);
  opacity: 0;
  transition: all 0.3s ease;
  z-index: 1000;
}

.toast.visible {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}

.toast.error { background: var(--error); }
.toast.success { background: var(--success); }
```

### Modals

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 90%;
  max-width: 400px;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}

.modal-body { padding: 1.25rem; }

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
}
```

### Fullscreen Editor Modal

```css
.modal-editor {
  width: 80%;
  height: 80%;
  max-width: 1200px;
  background: var(--surface);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
}

.modal-editor-textarea {
  flex: 1;
  padding: 1.25rem;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.9375rem;
  line-height: 1.6;
  border: none;
  resize: none;
  outline: none;
}
```

### Dropdowns

```css
.workspace-dropdown, .user-menu {
  position: absolute;
  top: calc(100% + 4px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  max-height: 300px;
  overflow-y: auto;
  display: none;
}

.workspace-dropdown.open, .user-menu.open {
  display: block;
}

.workspace-option, .user-menu-item {
  display: block;
  padding: 0.625rem 0.75rem;
  font-size: 0.875rem;
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s ease;
}

.workspace-option:hover, .user-menu-item:hover {
  background: var(--code-bg);
}

.workspace-option.active, .user-menu-item.active {
  background: var(--accent-bg);
  color: var(--accent);
}
```

### Empty States

```css
.empty-state {
  text-align: center;
  padding: 3rem 1.5rem;
  color: var(--text-secondary);
}

.empty-state p {
  margin-bottom: 1rem;
}
```

### Loading States

```css
.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading {
  color: var(--text-muted);
  font-style: italic;
}
```

---

## 7. Animations

### Transitions
Default transition: `0.15s ease` (stored in `--transition`)

Used for:
- Button hover states
- Input focus states
- Card hover effects
- Sidebar item hover
- Dropdown visibility

### Keyframes

```css
/* Spinner rotation */
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### Modal Transitions
```css
/* Modal fade in */
.modal-overlay {
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}

.modal-overlay.visible {
  opacity: 1;
  visibility: visible;
}

/* Modal scale in */
.modal-editor {
  transform: scale(0.95);
  transition: transform 0.2s ease;
}

.modal-overlay.visible .modal-editor {
  transform: scale(1);
}
```

### Toast Animation
```css
.toast {
  transform: translateX(-50%) translateY(100%);
  opacity: 0;
  transition: all 0.3s ease;
}

.toast.visible {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
```

---

## 8. UI Patterns

### Section Headers
Used to introduce content sections with optional actions:
```html
<div class="section-header">
  <h2>Section Title</h2>
  <button class="btn btn-primary">Action</button>
</div>
```

### Grid Layouts
```css
.grid { display: grid; gap: 1rem; }
.grid-2 { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.stack { display: flex; flex-direction: column; gap: 1rem; }
```

### Danger Zone
Destructive actions are placed in a visually distinct section:
```css
.danger-zone {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-light);
}

.danger-zone h4 {
  color: var(--error);
  margin-bottom: 0.5rem;
}
```

### Inline Editing Pattern
Editable fields show a pencil icon on hover and switch to input mode on click:
```html
<template x-if="!editing">
  <h2 @click="startEditing()" style="cursor: pointer;">
    <span x-text="value"></span>
    <svg><!-- pencil icon --></svg>
  </h2>
</template>
<template x-if="editing">
  <div>
    <input x-model="editedValue" @keydown.enter="save()" @keydown.escape="cancel()">
    <button class="btn btn-primary btn-sm">Save</button>
    <button class="btn btn-secondary btn-sm">Cancel</button>
  </div>
</template>
```

### Split Button
Action button with dropdown for additional options:
```html
<div class="action-dropdown">
  <button class="btn btn-primary" style="border-radius: ... 0 0 ...;">
    Run
  </button>
  <button class="btn btn-primary" style="border-radius: 0 ... ... 0;">
    <svg><!-- chevron --></svg>
  </button>
  <div class="action-menu">
    <button>Run</button>
    <button>Onboard</button>
  </div>
</div>
```

---

## 9. Skin System

Me Inc. supports visual theming through a skin system. Skins are CSS files that override the root CSS variables.

### Skin Location
Skins are stored in `worker/public/alpine/skins/`:
- `dark.css` - Dark mode theme
- `clean-corporate-clean.css`
- `clean-modern-saas-minimal.css`
- `bold-neo-brutalist.css`
- etc.

### Screenshots
Each skin has a corresponding screenshot in `skins/screenshots/` for the skin picker UI.

### How Skins Work
Skins are loaded dynamically and override `:root` CSS variables:
```javascript
// From common.js
MeInc.skin.set('dark');  // Loads skins/dark.css
MeInc.skin.set('');      // Removes skin, returns to default
```

### Creating a New Skin
1. Create a CSS file in `worker/public/alpine/skins/`
2. Override the `:root` variables
3. Add a screenshot to `skins/screenshots/`
4. Register in `skins.html`

Example skin structure:
```css
/* my-skin.css */
:root {
  --bg: #...;
  --surface: #...;
  --border: #...;
  /* ... override all variables ... */
}
```

---

## 10. Tech Stack Reference

| Category | Technology |
|----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Alpine.js 3.x |
| Styling | Vanilla CSS (custom properties) |
| Fonts | IBM Plex Sans, IBM Plex Mono (Google Fonts) |
| Icons | Inline SVG |
| Build | No build step (static files) |

---

## 11. Responsive Design

### Breakpoints
| Breakpoint | Width | Changes |
|------------|-------|---------|
| Mobile | < 640px | Header shrinks, username hidden |
| Tablet | < 768px | Sidebar becomes overlay, hamburger visible |
| Desktop | >= 768px | Full layout with sticky sidebar |

### Mobile Adaptations
```css
@media (max-width: 768px) {
  .hamburger { display: flex; }

  .app-sidebar {
    position: fixed;
    transform: translateX(-100%);
    z-index: 160;
  }

  .app-sidebar.open {
    transform: translateX(0);
  }

  .sidebar-overlay.visible {
    display: block;
  }
}

@media (max-width: 640px) {
  .header-main { height: 56px; }
  .user-trigger span { display: none; }
  .workspace-trigger span {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
```

---

## Quick Reference

### Common Class Combinations

```html
<!-- Primary button with icon -->
<button class="btn btn-primary">
  <svg>...</svg>
  Create
</button>

<!-- Card link in grid -->
<a href="..." class="card-link">
  <div class="card">
    <div class="card-title">Title</div>
    <div class="card-description">Description</div>
    <div class="card-meta">
      <span class="badge badge-neutral">v1.0.0</span>
    </div>
  </div>
</a>

<!-- Form field -->
<div class="form-group">
  <label class="form-label">Field Name</label>
  <input class="form-input" type="text">
  <p class="form-hint">Helper text</p>
</div>

<!-- Status badge -->
<span class="badge badge-success">Active</span>

<!-- Section with header and action -->
<div class="section-header">
  <h2>Agents</h2>
  <button class="btn btn-primary btn-sm">New Agent</button>
</div>
```

### Utility Classes
```css
.text-muted    /* var(--text-muted) */
.text-secondary /* var(--text-secondary) */
.text-sm       /* 0.875rem */
.text-xs       /* 0.8125rem */
.font-mono     /* IBM Plex Mono */
.mt-1, .mt-2, .mt-3  /* margin-top: 0.5rem, 1rem, 1.5rem */
.mb-1, .mb-2, .mb-3  /* margin-bottom: 0.5rem, 1rem, 1.5rem */
```

---

*Last updated: January 2025*
