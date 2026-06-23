(function () {
	'use strict';

	var MEITUAN_DEEPLINK = 'YOUR_MEITUAN_DEEPLINK';
	var MEITUAN_H5_FALLBACK = 'YOUR_MEITUAN_H5_FALLBACK_URL';
	var DRAW_DURATION = 1000;

	var drawScene = document.getElementById('drawScene');
	var startButton = document.getElementById('startButton');
	var loadingButton = document.getElementById('loadingButton');
	var resultCard = document.getElementById('resultCard');
	var dishNameEl = document.getElementById('dishName');
	var dishDescEl = document.getElementById('dishDesc');
	var meituanButton = document.getElementById('meituanButton');
	var againButton = document.getElementById('againButton');
	var backButton = document.querySelector('.nav-back');
	var ticketEls = Array.prototype.slice.call(document.querySelectorAll('.ticket'));

	var isDrawing = false;
	var currentDish = null;

	function makeDishSvg(bgColor, accentColor, markColor) {
		var svg = [
			'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">',
			'<rect width="96" height="96" rx="28" fill="' + bgColor + '"/>',
			'<circle cx="48" cy="50" r="29" fill="#fff8df"/>',
			'<path d="M25 56c7 15 39 15 46 0" fill="none" stroke="' + accentColor + '" stroke-width="7" stroke-linecap="round"/>',
			'<path d="M31 40h34" stroke="' + accentColor + '" stroke-width="6" stroke-linecap="round"/>',
			'<circle cx="37" cy="48" r="5" fill="' + markColor + '"/>',
			'<circle cx="52" cy="47" r="4" fill="' + markColor + '"/>',
			'<circle cx="63" cy="53" r="4" fill="' + markColor + '"/>',
			'</svg>'
		].join('');

		return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
	}

	var dishPool = [{
		name: '麻辣烫',
		desc: '想吃热乎又自由搭配的一顿，去美团看看附近有没有红包和优惠套餐。',
		cover: makeDishSvg('#fff1df', '#e9592f', '#79b928')
	}, {
		name: '炸鸡汉堡',
		desc: '今天适合吃点快乐的，去美团看看外卖红包和快餐优惠。',
		cover: makeDishSvg('#fff2c4', '#d88916', '#d94d3f')
	}, {
		name: '黄焖鸡米饭',
		desc: '稳妥管饱的一餐，去美团看看附近套餐和配送优惠。',
		cover: makeDishSvg('#fff7d8', '#d7a323', '#78a630')
	}, {
		name: '兰州拉面',
		desc: '快速解决一顿饭，去美团看看附近门店和红包入口。',
		cover: makeDishSvg('#eaf6ff', '#4d9ed4', '#e05b38')
	}, {
		name: '小火锅',
		desc: '想吃点有仪式感的，去美团看看附近有没有优惠套餐。',
		cover: makeDishSvg('#ffe9e7', '#d9412d', '#f5b339')
	}, {
		name: '米线米粉',
		desc: '酸辣鲜香的一碗，去美团看看外卖红包和附近优惠。',
		cover: makeDishSvg('#edf7df', '#75b92f', '#e06738')
	}, {
		name: '盖浇饭',
		desc: '简单管饱不出错，去美团看看附近套餐优惠。',
		cover: makeDishSvg('#fff4dc', '#cb8b2f', '#76a931')
	}, {
		name: '奶茶甜品',
		desc: '想喝点甜的，去美团看看附近饮品红包和优惠。',
		cover: makeDishSvg('#ffeef5', '#e486a5', '#c88136')
	}];

	function trackEvent(eventName, params) {
		console.log('[ad-landing-track]', eventName, params || {});
	}

	function pickRandom(list) {
		return list[Math.floor(Math.random() * list.length)];
	}

	function shuffle(list) {
		var arr = list.slice();
		for (var i = arr.length - 1; i > 0; i -= 1) {
			var j = Math.floor(Math.random() * (i + 1));
			var tmp = arr[i];
			arr[i] = arr[j];
			arr[j] = tmp;
		}
		return arr;
	}

	function getTicketDishes(pinnedDish) {
		var rest = dishPool.filter(function (dish) {
			return !pinnedDish || dish.name !== pinnedDish.name;
		});
		var next = pinnedDish ? [pinnedDish].concat(shuffle(rest)) : shuffle(rest);
		return next.slice(0, 4);
	}

	function refreshTickets(pinnedDish) {
		var dishes = getTicketDishes(pinnedDish);
		ticketEls.forEach(function (ticketEl, index) {
			var dish = dishes[index];
			var iconEl = ticketEl.querySelector('.dish-icon');
			var nameEl = ticketEl.querySelector('.ticket-name');
			if (!dish || !iconEl || !nameEl) return;
			iconEl.src = dish.cover;
			iconEl.alt = dish.name;
			nameEl.textContent = dish.name;
		});
	}

	function setDrawingState(nextValue) {
		isDrawing = nextValue;
		drawScene.classList.toggle('is-shaking', nextValue);
		startButton.hidden = nextValue || !!currentDish;
		loadingButton.hidden = !nextValue;
		startButton.disabled = nextValue;
		loadingButton.disabled = true;
		againButton.disabled = nextValue;
	}

	function showResult(dish) {
		currentDish = dish;
		dishNameEl.textContent = dish.name;
		dishDescEl.textContent = dish.desc;
		refreshTickets(dish);
		resultCard.hidden = false;
		startButton.hidden = true;
		trackEvent('sortition_result_show', {
			dishName: dish.name
		});
	}

	function runDraw() {
		if (isDrawing) return;
		currentDish = null;
		resultCard.hidden = true;
		refreshTickets();
		setDrawingState(true);

		window.setTimeout(function () {
			var dish = pickRandom(dishPool);
			setDrawingState(false);
			showResult(dish);
		}, DRAW_DURATION);
	}

	function startSortition() {
		trackEvent('click_sortition');
		runDraw();
	}

	function drawAgain() {
		trackEvent('click_again', {
			dishName: currentDish ? currentDish.name : ''
		});
		runDraw();
	}

	function handleGoMeituan() {
		var dishName = currentDish ? currentDish.name : '';
		trackEvent('click_meituan', {
			dishName: dishName
		});

		var startTime = Date.now();
		window.location.href = MEITUAN_DEEPLINK;

		window.setTimeout(function () {
			var diff = Date.now() - startTime;
			if (diff < 1800 && MEITUAN_H5_FALLBACK) {
				window.location.href = MEITUAN_H5_FALLBACK;
			}
		}, 1500);
	}

	function handleBack() {
		if (window.history.length > 1) {
			window.history.back();
		}
	}

	function bindEvents() {
		startButton.addEventListener('click', startSortition);
		againButton.addEventListener('click', drawAgain);
		meituanButton.addEventListener('click', handleGoMeituan);
		backButton.addEventListener('click', handleBack);
	}

	function init() {
		refreshTickets();
		bindEvents();
		trackEvent('landing_page_view');
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();

