// Component loader for Theta Tau website
document.addEventListener('DOMContentLoaded', function() {
    
    // Function to load component
    function loadComponent(selector, url) {
        const element = document.querySelector(selector);
        if (element) {
            fetch(url)
                .then(response => response.text())
                .then(html => {
                    element.innerHTML = html;
                    setActiveNavigation();
                })
                .catch(error => console.error('Error loading component:', error));
        }
    }
    
    // Function to set active navigation based on current page
    function setActiveNavigation() {
        const currentPage = getCurrentPageName();
        
        // Remove all active classes
        document.querySelectorAll('.header-nav-item').forEach(item => {
            item.classList.remove('header-nav-item--active');
            const link = item.querySelector('a');
            if (link) {
                link.removeAttribute('aria-current');
            }
        });
        
        document.querySelectorAll('.header-menu-nav-item').forEach(item => {
            item.classList.remove('header-menu-nav-item--active');
            const link = item.querySelector('a');
            if (link) {
                link.removeAttribute('aria-current');
            }
        });
        
        // Set active class for current page
        if (currentPage) {
            const navItems = document.querySelectorAll(`[data-page="${currentPage}"]`);
            navItems.forEach(item => {
                if (item.classList.contains('header-nav-item')) {
                    item.classList.add('header-nav-item--active');
                    const link = item.querySelector('a');
                    if (link) {
                        link.setAttribute('aria-current', 'page');
                    }
                } else if (item.classList.contains('header-menu-nav-item')) {
                    item.classList.add('header-menu-nav-item--active');
                    const link = item.querySelector('a');
                    if (link) {
                        link.setAttribute('aria-current', 'page');
                    }
                }
            });
        }
    }
    
    // Function to get current page name from URL
    function getCurrentPageName() {
        const path = window.location.pathname;
        const filename = path.split('/').pop();
        
        if (filename === 'index.html' || filename === '') {
            return 'home';
        }
        
        // Remove .html extension to get page name
        return filename.replace('.html', '');
    }
    
    // Load components
    loadComponent('#navigation-placeholder', 'components/navigation.html');
    loadComponent('#footer-placeholder', 'components/footer.html');
    
    // Initialize header background behavior
    initializeHeaderBackground();
    
    // Initialize mobile menu
    initializeMobileMenu();
});

// Header background functionality
function initializeHeaderBackground() {
    const header = document.querySelector('header');
    
    if (header) {
        // Initial check in case page is loaded already scrolled
        if (window.scrollY > 150) {
            header.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
        } else {
            header.style.backgroundColor = 'transparent';
        }
        
        // Add scroll event listener
        window.addEventListener('scroll', function() {
            if (window.scrollY > 150) {
                header.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
            } else {
                header.style.backgroundColor = 'transparent';
            }
        });
    }
}

// Mobile menu functionality
function initializeMobileMenu() {
    const mobileMenuBtn = document.querySelector('.header-burger-btn');
    const mobileMenu = document.querySelector('.header-menu');
    
    if (mobileMenuBtn && mobileMenu) {
        mobileMenuBtn.addEventListener('click', function() {
            mobileMenu.classList.toggle('active');
            document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
        });
    }
} 