(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.header-burger-btn');
        var menu = document.querySelector('.header-menu');
        if (!btn || !menu) return;

        function open() {
            menu.classList.add('menu-open');
            document.body.classList.add('menu-is-open');
            document.body.style.overflow = 'hidden';
        }

        function close() {
            menu.classList.remove('menu-open');
            document.body.classList.remove('menu-is-open');
            document.body.style.overflow = '';
        }

        btn.addEventListener('click', function () {
            menu.classList.contains('menu-open') ? close() : open();
        });

        menu.querySelectorAll('a').forEach(function (link) {
            link.addEventListener('click', close);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') close();
        });
    });
})();
