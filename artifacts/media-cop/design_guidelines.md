# Military News Feed - Design Guidelines

## Design Approach

**System Selection:** Material Design principles adapted for professional news consumption with inspiration from Bloomberg Terminal's information density and Linear's clean typography. This is a utility-first, information-dense application where scanning efficiency and clarity are paramount.

**Core Principles:**
- Information hierarchy over visual flourish
- Maximum scanability for time-constrained military leadership
- Professional, authoritative presentation
- Dense but organized content layout
- Clear visual categorization system

---

## Typography System

**Primary Font:** Inter or IBM Plex Sans (via Google Fonts CDN)
**Accent Font:** JetBrains Mono for timestamps and metadata

**Hierarchy:**
- Page Title: 2.5rem (40px), font-weight: 700, tracking tight
- Section Headers: 1.5rem (24px), font-weight: 600
- Headline Title: 1.125rem (18px), font-weight: 600, line-height: 1.4
- Headline Excerpt: 0.875rem (14px), font-weight: 400, line-height: 1.6
- Metadata/Timestamps: 0.75rem (12px), font-weight: 500, monospace
- Category Badges: 0.75rem (12px), font-weight: 600, uppercase, letter-spacing: 0.05em

---

## Layout System

**Spacing Primitives:** Tailwind units of 2, 4, 6, and 8 for consistent rhythm
- Component padding: p-4 to p-6
- Section spacing: space-y-6 to space-y-8
- Card margins: mb-4
- Internal element spacing: gap-2 to gap-4

**Grid Structure:**
- Container: max-w-7xl with px-6
- Main content area: 70% width (two-thirds)
- Sidebar filters: 30% width (one-third)
- Mobile: Single column stack

**Responsive Breakpoints:**
- Mobile (base): Single column, simplified filters
- Tablet (md): Two column with collapsible sidebar
- Desktop (lg): Full three-section layout (filters, headlines, details)

---

## Component Library

### Header Component
- Fixed top navigation bar, h-16
- Logo/Title on left with military-style insignia placeholder
- Real-time status indicator: "LIVE • Updated 2m ago" with pulse animation
- Filter quick-access buttons (All, Defense, Conflict, Policy)
- Auto-refresh toggle switch on right

### Headline Card Component
- Structured card layout with consistent padding (p-4)
- Top row: Category badge + timestamp + source indicator
- Headline text: Bold, prominent, truncated at 2 lines with ellipsis
- Excerpt preview: 2-3 lines of context, subtle styling
- Bottom row: Read More link + Share icon + Save icon
- Hover state: Subtle elevation increase (shadow-md to shadow-lg)
- Border on left side (w-1) for category visual indicator

### Category Badge Component
- Small pill design with rounded corners (rounded-full)
- Uppercase text, tight letter spacing
- Compact padding (px-3 py-1)
- Categories: DEFENSE, CONFLICT, POLICY, VETERANS, INTEL, GLOBAL, DOMESTIC

### Filter Sidebar Component
- Sticky positioning (top-20)
- Category checkboxes with headline counts
- Date range selector (Today, 24h, 48h, Week)
- Keyword search input with clear button
- Source filters (if multiple sources added)
- "Clear All Filters" button at bottom

### Loading States
- Skeleton screens for headline cards (3-4 placeholder cards)
- Shimmer animation effect for loading content
- Inline loading spinner for real-time updates

### Empty State Component
- Centered layout when no results
- Icon placeholder (<!-- CUSTOM ICON: military news icon -->)
- Clear message: "No headlines match your filters"
- Suggested action button to clear filters

### Status Indicators
- Connection status dot (connected/disconnected)
- Last updated timestamp with relative time (e.g., "2 minutes ago")
- Article count badge showing filtered results

---

## Page Structure

### Main Dashboard Layout
**No Hero Section** - This is a dashboard, not a marketing page. Immediate information display.

**Top Bar:** Header component spanning full width

**Main Content Area (Two-Column Desktop):**
- Left Column (30%): Filter sidebar, sticky positioned
- Right Column (70%): Scrollable headline feed with infinite scroll

**Headline Feed Structure:**
- Group headlines by time periods: "Last Hour", "Earlier Today", "Yesterday"
- 10-15 headlines visible before scroll
- Load more on scroll (infinite pagination)
- Quick-jump navigation for time periods

### Detail View (Optional Click-Through)
- Slide-in panel from right (lg screens) or full-screen modal (mobile)
- Full headline with complete article preview
- Direct link to original Drudge article
- Related headlines section
- Close button prominent top-right

---

## Interaction Patterns

### Real-Time Updates
- Soft notification bar slides down when new headlines available
- Click to refresh or auto-refresh after 5 seconds
- Smooth scroll to new content
- Pulse animation on new headline indicators

### Filtering
- Instant filter application (no submit button)
- Active filter count badge in header
- Smooth transitions when headlines appear/disappear

### Navigation
- External links open in new tab
- Internal detail views use slide/modal patterns
- Keyboard shortcuts for power users (J/K for next/previous)

---

## Accessibility Implementation

- ARIA labels on all interactive elements
- Keyboard navigation throughout (tab order, arrow keys for headline list)
- Focus indicators with high contrast rings (ring-2 ring-offset-2)
- Screen reader announcements for real-time updates
- Skip to content link
- Semantic HTML5 structure (header, main, article, aside)

---

## Content Density Strategy

**High-Density Layout Philosophy:**
- Maximize visible headlines without scrolling (8-10 on desktop)
- Compact card design with breathing room (not cramped)
- Strategic whitespace between sections, not within cards
- Information-rich previews without overwhelming

**Vertical Rhythm:**
- Consistent 24px (space-y-6) between major sections
- 16px (space-y-4) between headline cards
- 8px (space-y-2) internal card spacing

---

## Performance Considerations

- Virtual scrolling for large headline lists
- Lazy load images (if article thumbnails added later)
- Debounced search input (300ms delay)
- Optimistic UI updates for filter interactions
- Stale-while-revalidate caching strategy

---

## Future Expansion Hooks

- Placeholder sections for: notification preferences, saved headlines archive, analytics dashboard
- Modular component structure allows easy addition of new sources beyond Drudge
- Design accommodates both read-only and interactive features (commenting, sharing)