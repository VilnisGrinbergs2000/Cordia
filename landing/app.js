(function () {
  'use strict';

  document.documentElement.classList.add('js');

  const header = document.querySelector('.site-header');
  const nav = document.querySelector('.site-nav');
  const menuToggle = document.querySelector('.menu-toggle');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function setMenu(open) {
    if (!header || !menuToggle) return;
    header.classList.toggle('nav-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', function () {
      setMenu(!header.classList.contains('nav-open'));
    });

    if (nav) {
      nav.addEventListener('click', function (event) {
        if (event.target.closest('a')) setMenu(false);
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && header.classList.contains('nav-open')) {
        setMenu(false);
        menuToggle.focus();
      }
    });

    document.addEventListener('pointerdown', function (event) {
      if (header.classList.contains('nav-open') && !header.contains(event.target)) {
        setMenu(false);
      }
    });

    const desktopQuery = window.matchMedia('(min-width: 861px)');
    const closeOnDesktop = function (event) {
      if (event.matches) setMenu(false);
    };

    if (desktopQuery.addEventListener) {
      desktopQuery.addEventListener('change', closeOnDesktop);
    } else {
      desktopQuery.addListener(closeOnDesktop);
    }
  }

  function updateHeader() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  }

  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  // Relative by default: the same markup has to work on localhost and on the
  // deployed origin, and a baked-in host sends half the visitors somewhere that
  // does not exist. data-app-url still wins when a page really is cross-origin.
  const appUrl = (document.body.dataset.appUrl || '').replace(/\/+$/, '');

  // The app lives at /app; "/" is this landing page. Pointing the CTAs at the
  // bare origin reloaded the pitch instead of opening Cordia.
  document.querySelectorAll('.js-app-link').forEach(function (link) {
    link.href = appUrl + '/app';
  });

  const revealItems = Array.from(document.querySelectorAll('.reveal'));

  function showAll() {
    revealItems.forEach(function (item) {
      item.classList.add('is-visible');
      item.style.transitionDelay = '';
    });
  }

  if (!('IntersectionObserver' in window) || reduceMotion.matches) {
    showAll();
  } else {
    revealItems.forEach(function (item) {
      const siblings = Array.from(item.parentElement.children).filter(function (sibling) {
        return sibling.classList.contains('reveal');
      });
      const index = siblings.indexOf(item);
      if (index > 0) item.style.transitionDelay = Math.min(index * 55, 220) + 'ms';
    });

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
          window.setTimeout(function () {
            entry.target.style.transitionDelay = '';
          }, 900);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );

    revealItems.forEach(function (item) {
      observer.observe(item);
    });
  }

  const motionPreferenceChanged = function (event) {
    if (event.matches) showAll();
  };

  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener('change', motionPreferenceChanged);
  } else {
    reduceMotion.addListener(motionPreferenceChanged);
  }
})();
