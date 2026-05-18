---
layout: post_layout
title: "时间处理库std::chrono"
date: 2025-08-29 19:24:21 +0800
categories: [C++语言]
location: 西安
excerpt_separator: "```"
---

<h4 style="" id="1%E3%80%81-std%3A%3Achrono">1、 <code>std::chrono</code></h4><p style="text-indent: 2em">前言: 最近项目中频繁用<code>std::chrono</code>，使用起来特别灵活，避免了传统时间函<code>time()</code>的类型混淆问题，记录下使用过程中的理解。</p><p style="text-indent: 2em"><code>std::chrono</code>是C++11引入的时间处理库，提供了一套类型安全的时间处理工具，用于测量时间间隔、处理时间点和执行时间相关计算。C++20添加了日志和时区支持。</p><h5 style="" id="%E4%B8%89%E5%A4%A7%E6%A0%B8%E5%BF%83%E7%BB%84%E4%BB%B6">三大核心组件</h5><ul><li><p style="">时钟（Clocks）<code>std::chrono</code>提供了几种类型的时钟</p></li></ul><p style="margin-left: 24px!important">  1. <code>system_clock</code>:系统范围的实时时钟，可以转换为日历时间</p><p style="margin-left: 24px!important">  2. <code>steady_clock</code>:单调时钟，保证时间不会减少，适合测量时间间隔</p><p style="margin-left: 24px!important">  3. <code>high_resolution_clock</code>:最高精度的时间，通常<code>steady_clock</code>或<code>system_clock</code>的别名</p><pre collapsed="true"><code>  #include &lt;chrono&gt;

std::chrono::time_point&lt;std::chrono::steady_clock&gt; start = std::chrono::steady_clock::now();</code></pre><p style=""> - 时间点（Time Points）:表示特定时钟上的一个时间点，是时钟和持续时间组合的模板类</p><p style="">- 持续时间（Durations）:表示时间间隔，由数值和单位组成</p><pre><code>std::chrono::duration&lt;int,ratio&lt;1,1&gt;&gt; seconds(5);//5秒

std::chrono::duration&lt;int,ratio&lt;60,1&gt;&gt; minutes(1.5);//1.5分钟##### 常用操作</code></pre><p style="">- 测量代码执行时间</p><pre><code>std::chrono::time_point&lt;std::chrono::steady_clock&gt; start = std::chrono::steady_clock::now();

//要测量的代码

std::chrono::time_point&lt;std::chrono::steady_clock&gt; end = std::chrono::steady_clock::now();

std::chrono::dutation dutation= std::chrono::dutation_cast&lt;millisenconds&gt;(end-start);

cout&lt;&lt;"耗时："&lt;&lt;dutation.count()&lt;&lt;"毫秒"&lt;&lt;endl;</code></pre><p style="">- 时间点运算</p><pre><code>/*

  预定义：

  nanoseconds

  microseconds

  milliseconds

  seconds

  minutes

  hours

  */  
auto now = std::chrono::system_clock::now();

auto one_hour_later = now + std::chrono::hours(1);

auto ten_minutes_ago = now - std::chrono::minutes(10);</code></pre><p style="">  </p><p style="">- 持续时间转换</p><pre><code> std::chrono::millisenconds ms(1500);

//1秒截断:当持续时间 达到或超过1秒 但不足2秒时，转换为 seconds 会截断为 1

std::chrono::senconds sen = std::chrono::duration_cast&lt;std::chrono::senconds&gt;(ms);//1秒(截断)

//0秒截断:当持续时间 不足1秒 时，转换为 seconds 会直接截断为 0

std::chrono::milliseconds ms(500);       // 500毫秒（0.5秒）

std::chrono::seconds sec = std::chrono::duration_cast&lt;std::chrono::seconds&gt;(ms); </code></pre><p style="">- 系统时钟与日历时间转换</p><pre><code>auto now = std::chrono::system_clock::now();
time_t now_time = std::chrono::system_clock::to_time_t(now);
auto tp = std::chrono::system_clock::from_time_t(now_time);</code></pre><p style="">  </p>