# Theta Tau Zeta Delta - University of South Carolina

Official website for Theta Tau Zeta Delta chapter at the University of South Carolina.

## 🚀 Quick Start

### Prerequisites
- Node.js (v14 or higher)
- npm

### Installation
```bash
# Install dependencies
npm install
```

### Running the Server
```bash
# Start the development server
npm start
```

The server will start at `http://localhost:3000/`

### Alternative Commands
```bash
# Using the built-in server
npm start

# Using http-server (alternative)
npm run serve

# Development mode with nodemon (if installed globally)
nodemon server.js
```

## 📁 Project Structure

```
thetatauzd.org/
├── index.html          # Main homepage
├── rush.html           # Rush information
├── brotherhood.html    # Brotherhood page
├── profession.html     # Professional development
├── service.html        # Community service
├── brothers.html       # Brothers directory
├── activities.html     # Activities and events
├── house.html          # House information
├── cart.html           # Shopping cart (if applicable)
├── Images/             # Image assets
├── css/                # Stylesheets
├── js/                 # JavaScript files
└── components/         # Reusable components
```

## 🎨 Features

- **Responsive Design**: Works on all devices
- **Modern UI**: Clean, professional interface
- **Fast Loading**: Optimized images and assets
- **SEO Optimized**: Proper meta tags and structure
- **Accessibility**: WCAG compliant

## 🔧 Development

### Adding New Pages
1. Create a new HTML file in the `thetatauzd.org/` directory
2. Follow the existing page structure
3. Update navigation links as needed

### Styling
- Main styles: `css/site.css`
- Component styles: `css/static.css`
- Brotherhood cards: `css/brotherhood_cards.css`

### Images
- Store images in `Images/` directory
- **Rush assets** (event photos, timeline, backgrounds, LinkTree): use `Images/rush/`. All rush page images live here so you can update them in one place. Update paths in `rush.html` if you add new rush images.
- Use WebP format for better performance
- Run `python convert_to_webp.py` to convert images

## 🔄 What to Update Regularly

| What | Where to update |
|------|-----------------|
| **Leadership / contact** (Regent, Vice Regent, Rush Chairs, Alumni Correspondent) | Footer on every page: `index.html`, `brotherhood.html`, `profession.html`, `rush.html`, `service.html`. Also update the Contact section in this README. |
| **Rush images** (hero, timeline, event photos, backgrounds, LinkTree) | Add or replace files in `Images/rush/`. Only `rush.html` references these; paths use `./Images/rush/`. |
| **Rush open/closed & semester** | **`js/rush-config.js`** — set `isOpen: true` when rush opens, `isOpen: false` when it closes; set `nextSemester` (e.g. Spring 2026). When open, set `rushTitle`, `ctaLine`, `rushLinkUrl`. |
| **Rush season & links** (e.g. “Fall 2025 Rush”, GroupMe, coffee chat) | `rush.html`: the “Rush Information” section and any CTA text or links. |
| **Company logos** (profession / recruitment) | `Images/Companies/`. Referenced in `rush.html` and possibly `profession.html`. |
| **Brotherhood / service / profession photos** | `Images/` (and `Images/optimized/` if you use it). Check `brotherhood.html`, `service.html`, `index.html`, `profession.html` for paths. |

Tip: Search the repo for the old text (e.g. semester name or officer name) to find every place that needs an update.

## 🌐 Deployment

The site can be deployed to any static hosting service:
- Netlify
- Vercel
- GitHub Pages
- AWS S3
- Any web server

## 📞 Contact

For questions about the website or Theta Tau Zeta Delta:
- **Regent**: Jack Schmitt
- **Vice Regent**: Nicole Hoeker
- **Rush Chairs**: Bradley Alford, Kaylee Molitor
- **Alumni Correspondent**: Carlos Arenas

## 📄 License

This project is for Theta Tau Zeta Delta chapter use only. 