# Design System

This document defines the design tokens, component patterns, and visual guidelines for building consistent user interfaces. Use this as the single source of truth when implementing UI components.

---

## 1. Typography

### Font Families
- **Primary (Sans-serif):** `IBM Plex Sans` - Used for all body text and UI elements
- **Monospace:** `IBM Plex Mono` - Used for code, technical identifiers, and log output

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

  /* Layout */
  --radius: 8px;
  --radius-lg: 12px;
  --shadow: 0 1px 3px rgba(31, 35, 40, 0.04);
  --shadow-md: 0 3px 6px rgba(31, 35, 40, 0.08);
  --transition: 0.15s ease;
}
```

### Dark Mode
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
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 3px 6px rgba(0, 0, 0, 0.4);
}
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
| Token | Value | Usage |
|-------|-------|-------|
| `0.25rem` | 4px | Tight gaps, badge internal spacing |
| `0.5rem` | 8px | Small gaps, icon-text spacing |
| `0.75rem` | 12px | Card meta gaps |
| `1rem` | 16px | Section spacing, standard padding |
| `1.25rem` | 20px | Card padding |
| `1.5rem` | 24px | Large section spacing |
| `2rem` | 32px | Main content padding |
| `3rem` | 48px | Empty state padding |
| `4rem` | 64px | Main vertical padding |

### Layout Structure

#### Standard Page Layout
```
┌─────────────────────────────────────────────────┐
│  Header (64px height, sticky)                   │
│  ┌─────────────────────────────────────────┐    │
│  │ Logo │ Navigation │ User Menu           │    │
│  └─────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  Main Content (.container max-width: 900px)     │
│  - Section headers with actions                 │
│  - Grid of cards                                │
└─────────────────────────────────────────────────┘
```

#### Sidebar Layout
```
┌──────────────────────────────────────────────────────────┐
│  Header (64px height, sticky)                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Hamburger │ Logo │ Navigation │ User Menu          │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────┬───────────────────────────────────────────┤
│  Sidebar     │  Main Content                             │
│  (240px)     │  max-width: 800px                         │
│  ┌────────┐  │  ┌───────────────────────────────────┐    │
│  │ Nav    │  │  │ Page header + actions             │    │
│  │ Group  │  │  ├───────────────────────────────────┤    │
│  │ ─────  │  │  │ Content                           │    │
│  │ Item 1 │  │  │                                   │    │
│  │ Item 2 │  │  │                                   │    │
│  │ + Add  │  │  │                                   │    │
│  ├────────┤  │  │                                   │    │
│  │ Nav    │  │  └───────────────────────────────────┘    │
│  │ Group  │  │                                           │
│  └────────┘  │                                           │
└──────────────┴───────────────────────────────────────────┘
```

### Key Dimensions
| Element | Size |
|---------|------|
| Header height | 64px (56px on mobile) |
| Sidebar width | 240px |
| Container max-width | 900px (standard), 800px (with sidebar) |
| Button height | ~38px (padding-based) |
| Input height | ~38px (padding-based) |
| Card padding | 1.25rem (20px) |

---

## 4. Icons

### Icon Approach
Use **inline SVG icons** rather than an icon font library. Icons are embedded directly in HTML with consistent viewBox dimensions.

### Icon Sizing
```html
<!-- 16x16 (small, inline with text) -->
<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">...</svg>

<!-- 24x24 (larger icons, logo) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">...</svg>
```

### Common Icons
| Usage | Description |
|-------|-------------|
| Chevron down | Dropdown indicators |
| Plus | Add/create actions |
| Play | Run/execute action |
| Pencil | Edit action |
| Trash | Delete action |
| Hamburger | Mobile menu toggle |
| External link | External navigation |
| Caret right | Expandable items |
| X / Close | Dismiss, close modal |
| Check | Success, confirmation |

### Icon Style Guidelines
- Use `fill="currentColor"` to inherit text color
- Stroke icons use `stroke="currentColor"` with `stroke-width="2"`
- Icons in buttons should have `0.5rem` gap from text
- Sidebar icons: 16x16
- Button icons: 16x16 or 14x14

---

## 5. Components

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
  transition: all var(--transition);
  text-decoration: none;
}

.btn:hover { text-decoration: none; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn-secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
.btn-secondary:hover:not(:disabled) {
  background: var(--code-bg);
  border-color: var(--text-muted);
}

.btn-danger {
  background: var(--surface);
  color: var(--error);
  border-color: var(--border);
}
.btn-danger:hover:not(:disabled) {
  background: var(--error-bg);
  border-color: var(--error);
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border-color: transparent;
  padding: 0.5rem 0.75rem;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--code-bg);
  color: var(--text);
}
```

#### Sizes
| Size | Class | Padding |
|------|-------|---------|
| Default | `.btn` | 0.625rem 1rem |
| Small | `.btn-sm` | 0.375rem 0.625rem |
| Icon only | `.btn-icon` | 0.5rem |

```css
.btn-sm { padding: 0.375rem 0.625rem; font-size: 0.8125rem; }
.btn-icon { padding: 0.5rem; }
```

---

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
  transition: all var(--transition);
}

.form-input:focus, .form-select:focus, .form-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}

.form-textarea {
  font-family: 'IBM Plex Mono', monospace;
  resize: vertical;
  min-height: 120px;
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

---

### Cards

```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  transition: all var(--transition);
}

.card-link {
  display: block;
  text-decoration: none;
  color: inherit;
}
.card-link:hover { text-decoration: none; }
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

---

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

---

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

.sidebar-section {
  padding: 1rem 0;
}

.sidebar-section:not(:last-child) {
  border-bottom: 1px solid var(--border-light);
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
  text-decoration: none;
  transition: all var(--transition);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.sidebar-item:hover {
  background: var(--code-bg);
  color: var(--text);
  text-decoration: none;
}

.sidebar-item.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 500;
}

.sidebar-item svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
```

---

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

tr:last-child td { border-bottom: none; }
tr:hover td { background: var(--code-bg); }
```

---

### Banners / Alerts

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

.banner-error {
  background: var(--error-bg);
  color: var(--error);
  border: 1px solid var(--error);
}
```

---

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

---

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
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}

.modal-overlay.visible {
  opacity: 1;
  visibility: visible;
}

.modal {
  width: 90%;
  max-width: 400px;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  transform: scale(0.95);
  transition: transform 0.2s ease;
}

.modal-overlay.visible .modal {
  transform: scale(1);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}

.modal-header h3 {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text);
}

.modal-body {
  padding: 1.25rem;
}

.modal-body p {
  margin-bottom: 0.5rem;
}
.modal-body p:last-child {
  margin-bottom: 0;
}

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
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
}

.modal-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}

.modal-editor-textarea {
  flex: 1;
  width: 100%;
  padding: 1.25rem;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--text);
  background: var(--surface);
  border: none;
  resize: none;
  outline: none;
}

.modal-editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
}
```

---

### Dropdowns

```css
.dropdown {
  position: relative;
}

.dropdown-trigger {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  transition: all var(--transition);
}

.dropdown-trigger:hover {
  border-color: var(--accent);
  background: var(--surface);
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  max-height: 300px;
  overflow-y: auto;
  display: none;
  z-index: 100;
}

.dropdown-menu.open {
  display: block;
}

.dropdown-item {
  display: block;
  padding: 0.625rem 0.75rem;
  font-size: 0.875rem;
  color: var(--text);
  cursor: pointer;
  transition: background var(--transition);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}

.dropdown-item:hover {
  background: var(--code-bg);
  text-decoration: none;
}

.dropdown-item.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.dropdown-divider {
  height: 1px;
  background: var(--border-light);
  margin: 0.25rem 0;
}
```

---

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

---

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

## 6. Animations

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

## 7. UI Patterns

### Section Headers
Used to introduce content sections with optional actions:
```html
<div class="section-header">
  <h2>Section Title</h2>
  <button class="btn btn-primary">Action</button>
</div>
```

```css
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
}
```

### Grid Layouts
```css
.grid { display: grid; gap: 1rem; }
.grid-2 { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.stack { display: flex; flex-direction: column; gap: 1rem; }
.stack-sm { gap: 0.5rem; }
.stack-lg { gap: 1.5rem; }
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

.danger-zone p {
  font-size: 0.875rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
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
  <button class="btn btn-primary" style="border-top-right-radius: 0; border-bottom-right-radius: 0;">
    Primary Action
  </button>
  <button class="btn btn-primary" style="border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 1px solid rgba(255,255,255,0.2);">
    <svg><!-- chevron down --></svg>
  </button>
  <div class="dropdown-menu">
    <button class="dropdown-item">Option 1</button>
    <button class="dropdown-item">Option 2</button>
  </div>
</div>
```

---

## 8. Theming

### Theme Implementation
Themes are implemented by overriding CSS custom properties in `:root`. Create separate CSS files for each theme that override the default values.

### Example Theme File
```css
/* dark-theme.css */
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
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 3px 6px rgba(0, 0, 0, 0.4);
}
```

### Loading Themes Dynamically
```javascript
function setTheme(themeId) {
  // Remove existing theme
  const existing = document.getElementById('theme-stylesheet');
  if (existing) existing.remove();

  // Apply new theme
  if (themeId) {
    const link = document.createElement('link');
    link.id = 'theme-stylesheet';
    link.rel = 'stylesheet';
    link.href = `themes/${themeId}.css`;
    document.head.appendChild(link);
  }

  // Persist preference
  localStorage.setItem('theme', themeId);
}
```

---

## 9. Responsive Design

### Breakpoints
| Breakpoint | Width | Changes |
|------------|-------|---------|
| Mobile | < 640px | Header shrinks, usernames hidden |
| Tablet | < 768px | Sidebar becomes overlay, hamburger visible |
| Desktop | >= 768px | Full layout with sticky sidebar |

### Mobile Adaptations
```css
@media (max-width: 768px) {
  .hamburger { display: flex; }

  .app-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 160;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    height: 100vh;
  }

  .app-sidebar.open {
    transform: translateX(0);
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 150;
  }

  .sidebar-overlay.visible {
    display: block;
  }

  .app-main {
    padding: 1.5rem 1rem;
  }
}

@media (max-width: 640px) {
  .header-main { height: 56px; }
  .user-trigger span { display: none; }

  .dropdown-trigger span {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
```

---

## 10. Utility Classes

```css
/* Text colors */
.text-muted { color: var(--text-muted); }
.text-secondary { color: var(--text-secondary); }

/* Text sizes */
.text-sm { font-size: 0.875rem; }
.text-xs { font-size: 0.8125rem; }

/* Font */
.font-mono { font-family: 'IBM Plex Mono', monospace; }

/* Margins */
.mt-1 { margin-top: 0.5rem; }
.mt-2 { margin-top: 1rem; }
.mt-3 { margin-top: 1.5rem; }
.mb-1 { margin-bottom: 0.5rem; }
.mb-2 { margin-bottom: 1rem; }
.mb-3 { margin-bottom: 1.5rem; }
```

---

## Quick Reference

### Common Class Combinations

```html
<!-- Primary button with icon -->
<button class="btn btn-primary">
  <svg width="16" height="16">...</svg>
  Create
</button>

<!-- Card link in grid -->
<a href="..." class="card-link">
  <div class="card">
    <div class="card-title">Title</div>
    <div class="card-description">Description text</div>
    <div class="card-meta">
      <span class="badge badge-neutral">Tag</span>
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
  <h2>Section Title</h2>
  <button class="btn btn-primary btn-sm">New Item</button>
</div>

<!-- Sidebar navigation item -->
<a href="..." class="sidebar-item active">
  <svg width="16" height="16">...</svg>
  <span>Navigation Item</span>
</a>

<!-- Table -->
<div class="table-wrapper">
  <table>
    <thead>
      <tr>
        <th>Column 1</th>
        <th>Column 2</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Value 1</td>
        <td>Value 2</td>
      </tr>
    </tbody>
  </table>
</div>

<!-- Banner -->
<div class="banner banner-warning">
  <span>Warning message here</span>
  <button class="btn btn-sm">Action</button>
</div>

<!-- Empty state -->
<div class="empty-state">
  <p>No items found.</p>
  <button class="btn btn-primary">Create First Item</button>
</div>
```

---

*Last updated: January 2025*
