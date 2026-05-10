/**
 * search.js — 博客搜索功能
 * 功能：搜索弹窗、关键词高亮、搜索历史记录
 */
(function () {
  'use strict';

  var searchData = null;
  var MAX_HISTORY = 5;

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem('searchHistory') || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveHistory(query) {
    if (!query || query.length < 2) return;
    var history = getHistory().filter(function (h) { return h !== query; });
    history.unshift(query);
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    localStorage.setItem('searchHistory', JSON.stringify(history));
  }

  function highlightKeyword(text, query) {
    if (!query) return text;
    var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
  }

  function renderHistory(searchResults) {
    var history = getHistory();
    if (history.length === 0) {
      searchResults.innerHTML = '<div class="search-hint">输入至少 2 个字符搜索文章...</div>';
      return;
    }
    var html = '<div class="search-history">'
      + '<div class="search-history-title"><i class="fa-solid fa-clock-rotate-left"></i> 最近搜索</div>'
      + history.map(function (h) {
          return '<span class="search-history-item" data-query="' + h.replace(/"/g, '&quot;') + '">' + h + '</span>';
        }).join('')
      + '</div>';
    searchResults.innerHTML = html;

    searchResults.querySelectorAll('.search-history-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var searchInput = document.getElementById('searchInput');
        if (searchInput) {
          searchInput.value = item.getAttribute('data-query');
          searchInput.dispatchEvent(new Event('input'));
        }
      });
    });
  }

  function loadSearchData(callback) {
    if (searchData) { callback(searchData); return; }
    var searchResults = document.getElementById('searchResults');
    if (searchResults) {
      searchResults.innerHTML = '<div class="search-hint"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/search.json', true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        searchData = JSON.parse(xhr.responseText);
        callback(searchData);
      }
    };
    xhr.send();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var searchToggle = document.getElementById('searchToggle');
    var searchOverlay = document.getElementById('searchOverlay');
    var searchInput = document.getElementById('searchInput');
    var searchResults = document.getElementById('searchResults');
    var searchClose = document.getElementById('searchClose');

    function openSearch() {
      if (!searchOverlay) return;
      searchOverlay.classList.add('active');
      if (searchInput) searchInput.value = '';
      if (searchResults) renderHistory(searchResults);
      setTimeout(function () { if (searchInput) searchInput.focus(); }, 100);
    }

    function closeSearch() {
      if (searchOverlay) searchOverlay.classList.remove('active');
    }

    if (searchToggle) searchToggle.addEventListener('click', openSearch);
    if (searchClose) searchClose.addEventListener('click', closeSearch);
    if (searchOverlay) {
      searchOverlay.addEventListener('click', function (e) {
        if (e.target === searchOverlay) closeSearch();
      });
    }

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openSearch();
      }
      if (e.key === 'Escape' && searchOverlay && searchOverlay.classList.contains('active')) {
        closeSearch();
      }
    });

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var query = this.value.trim().toLowerCase();
        if (query.length < 2) {
          renderHistory(searchResults);
          return;
        }
        loadSearchData(function (data) {
          var results = data.filter(function (post) {
            return post.title.toLowerCase().indexOf(query) !== -1 ||
                   post.excerpt.toLowerCase().indexOf(query) !== -1 ||
                   post.categories.join(' ').toLowerCase().indexOf(query) !== -1;
          });
          if (results.length === 0) {
            searchResults.innerHTML = '<div class="search-empty">没有找到相关文章</div>';
          } else {
            saveHistory(query);
            var html = results.slice(0, 10).map(function (post) {
              return '<a href="' + post.url + '" class="search-result-item">'
                + '<div class="search-result-title">' + highlightKeyword(post.title, query) + '</div>'
                + '<div class="search-result-meta">' + post.date
                + (post.categories.length ? ' · ' + post.categories.join(', ') : '')
                + '</div></a>';
            }).join('');
            searchResults.innerHTML = html;
          }
        });
      });
    }

    // 移动端菜单切换
    var toggler = document.getElementById('navToggler');
    var menu = document.getElementById('navbarMenu');
    if (toggler && menu) {
      toggler.addEventListener('click', function () {
        menu.classList.toggle('active');
        var icon = toggler.querySelector('i');
        if (menu.classList.contains('active')) {
          icon.className = 'fa-solid fa-xmark';
        } else {
          icon.className = 'fa-solid fa-bars';
        }
      });
    }

    // 移动端下拉菜单
    var dropdowns = document.querySelectorAll('.nav-item');
    dropdowns.forEach(function (item) {
      var link = item.querySelector('.dropdown-icon');
      if (link && window.innerWidth <= 992) {
        var navLink = item.querySelector('.nav-link');
        navLink.addEventListener('click', function (e) {
          if (item.querySelector('.dropdown-menu')) {
            e.preventDefault();
            item.classList.toggle('open');
            var isOpen = item.classList.contains('open');
            navLink.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          }
        });
      }
    });
  });
})();
