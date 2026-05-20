/* fdroid-store docs — tiny enhancement script. No framework. */
(function () {
  // -- mobile nav -------------------------------------------------------
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');
  if (header && toggle) {
    toggle.addEventListener('click', function () {
      header.classList.toggle('nav-open');
      var expanded = header.classList.contains('nav-open');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  // -- mark current page in nav ----------------------------------------
  (function markActive() {
    var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('.nav .links a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').toLowerCase();
      if (!href) return;
      var leaf = href.split('/').pop() || 'index.html';
      if (leaf === here) a.classList.add('active');
    });
  })();

  // -- copy buttons (.snippet, .code) ----------------------------------
  document.querySelectorAll('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.closest('.snippet, .code, .ui-card');
      if (!target) return;
      var pre = target.querySelector('pre, code');
      if (!pre) return;
      var text = pre.innerText.replace(/ /g, ' ');
      navigator.clipboard.writeText(text).then(function () {
        var orig = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('ok');
        setTimeout(function () {
          btn.textContent = orig;
          btn.classList.remove('ok');
        }, 1600);
      }).catch(function () {
        btn.textContent = '!';
        setTimeout(function () { btn.textContent = 'copy'; }, 1600);
      });
    });
  });

  // -- TOC active section ----------------------------------------------
  // Scroll-position scheme — the active link is whichever section's top
  // has most recently crossed below the sticky header. Beats Intersection-
  // Observer here: with overlapping bands the next section can win the
  // race while the user's still reading the current one.
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length) {
    var sections = tocLinks.map(function (a) {
      var id = a.getAttribute('href').slice(1);
      return { id: id, el: document.getElementById(id), link: a };
    }).filter(function (s) { return s.el; });

    // Offset: a touch below the 64px sticky header. Anything whose top
    // is above this line counts as "scrolled into".
    var OFFSET = 110;

    var update = function () {
      var current = sections[0];
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.getBoundingClientRect().top - OFFSET <= 0) {
          current = sections[i];
        } else {
          break;
        }
      }
      tocLinks.forEach(function (l) { l.classList.remove('active'); });
      if (current && current.link) current.link.classList.add('active');
    };

    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { update(); ticking = false; });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  // -- reveal-on-scroll ------------------------------------------------
  if ('IntersectionObserver' in window) {
    var reveal = document.querySelectorAll('.reveal');
    if (reveal.length) {
      var rio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            rio.unobserve(e.target);
          }
        });
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
      reveal.forEach(function (el) { rio.observe(el); });
    }
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
