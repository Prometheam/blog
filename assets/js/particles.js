/**
 * particles.js — 粒子网络动画
 * 用于首页背景粒子效果
 */
(function () {
  // 尊重用户的减少动效偏好
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var canvas = document.getElementById('particleCanvas');
    if (canvas) canvas.style.display = 'none';
    return;
  }

  var canvas = document.getElementById('particleCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var particles = [];
  var mouse = { x: null, y: null };
  var particleCount = 50;
  var maxDist = 120;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  resize();
  window.addEventListener('resize', resize);

  // 鼠标交互
  document.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  document.addEventListener('mouseleave', function () {
    mouse.x = null;
    mouse.y = null;
  });

  function Particle() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.vx = (Math.random() - 0.5) * 0.5;
    this.vy = (Math.random() - 0.5) * 0.5;
    this.radius = Math.random() * 1.5 + 0.5;
  }

  Particle.prototype.update = function () {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
    if (this.y < 0 || this.y > canvas.height) this.vy *= -1;
  };

  Particle.prototype.draw = function () {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(240, 165, 0, 0.5)';
    ctx.fill();
  };

  // 初始化粒子
  for (var i = 0; i < particleCount; i++) {
    particles.push(new Particle());
  }

  function drawLines() {
    // 网格空间分区：将 Canvas 划分为 maxDist × maxDist 的格子，
    // 每帧只检查相邻格（最多 9 格）中的粒子对，将 O(n²) 降至 O(n·k)
    var cellSize = maxDist;
    var cols = Math.ceil(canvas.width / cellSize) + 1;
    var rows = Math.ceil(canvas.height / cellSize) + 1;
    var gridSize = cols * rows;

    // 每帧重建网格（粒子会移动）
    var grid = new Array(gridSize);
    for (var g = 0; g < gridSize; g++) grid[g] = [];

    for (var k = 0; k < particles.length; k++) {
      var col = Math.floor(particles[k].x / cellSize);
      var row = Math.floor(particles[k].y / cellSize);
      var key = row * cols + col;
      if (key >= 0 && key < gridSize) grid[key].push(k);
    }

    for (var i = 0; i < particles.length; i++) {
      var ci = Math.floor(particles[i].x / cellSize);
      var ri = Math.floor(particles[i].y / cellSize);

      // 遍历 3×3 邻域格
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          var nc = ci + dc;
          var nr = ri + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          var neighbors = grid[nr * cols + nc];
          for (var n = 0; n < neighbors.length; n++) {
            var j = neighbors[n];
            if (j <= i) continue; // 避免重复检查同一对

            var dx = particles[i].x - particles[j].x;
            var dy = particles[i].y - particles[j].y;
            var dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < maxDist) {
              var opacity = (1 - dist / maxDist) * 0.15;
              ctx.beginPath();
              ctx.moveTo(particles[i].x, particles[i].y);
              ctx.lineTo(particles[j].x, particles[j].y);
              ctx.strokeStyle = 'rgba(240, 165, 0, ' + opacity + ')';
              ctx.lineWidth = 0.5;
              ctx.stroke();
            }
          }
        }
      }

      // 鼠标连线
      if (mouse.x !== null) {
        var dx2 = particles[i].x - mouse.x;
        var dy2 = particles[i].y - mouse.y;
        var dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

        if (dist2 < 150) {
          var opacity2 = (1 - dist2 / 150) * 0.3;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.strokeStyle = 'rgba(255, 107, 53, ' + opacity2 + ')';
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < particles.length; i++) {
      particles[i].update();
      particles[i].draw();
    }
    drawLines();
    requestAnimationFrame(animate);
  }

  animate();
})();
