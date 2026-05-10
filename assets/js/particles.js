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
    for (var i = 0; i < particles.length; i++) {
      for (var j = i + 1; j < particles.length; j++) {
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
