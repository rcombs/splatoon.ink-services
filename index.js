"use strict";

var deepEqual = require('deep-equal'),
    express = require('express'),
    request = require('request'),
    xml2js = require('xml2js'),
    cors = require('cors'),
    jsdom = require('jsdom'),
    CookieJar = require('tough-cookie').CookieJar,
    FileCookieStore = require('tough-cookie-filestore');

var conf = require(process.argv[2] || './config.json');

function pre(s) {
  return 'https://' + conf.domain + conf.prefix + s;
}

var cookieJar = new CookieJar(new FileCookieStore(conf.cookiePath));

var CF = require('cloudflare-api'),
    cf = new CF(conf.cf);

var app = express();

conf.threads && conf.threads.forEach(function(thread) {
  var board = thread.board || 'vg';
  var lastCheck = 0;
  var lastThreadNo = 0;
  app.get((thread.endpoint || '/ink/'), function (req, res, next) {
    if (lastCheck > Date.now() - 1000 * 30)
      return res.location('https://boards.4chan.org/' + board + '/thread/' + lastThreadNo).status(307).send('FOUND THREAD\n');

    request({url: 'https://a.4cdn.org/' + board + '/catalog.json', json: true}, function (error, response, body) {
      if (error)
        return next(error);

      try {
        var chosenThread;

        for (var i = 0; i < body.length; i++) {
          var page = body[i];
          for (var j = 0; j < page.threads.length; j++) {
            var thd = page.threads[j];
            if (thd.sub.indexOf(thread.searchString || '/ink/') == 0) {
              chosenThread = thd;
              break;
            }
          }
          if (chosenThread)
            break;
        }

        if (!chosenThread)
          return res.send('NO /INK/ THREAD FOUND!');

        lastThreadNo = chosenThread.no;
        lastCheck = Date.now();
        res.location('https://boards.4chan.org/vg/thread/' + chosenThread.no).status(307).send('FOUND THREAD\n');
      } catch (e) {
        return next(e);
      }
    });
  });
});

var cachedSchedule = {
  updateTime: 0,
};

var scheduleHeaders = {
};

var rulesNames = {
  'ガチエリア': 'Splat Zones',
  'ガチヤグラ': 'Tower Control',
  'ガチホコ':   'Rainmaker',
};

var mapsNames = {
  'デカライン高架下':   'Urchin Underpass',
  'ホッケふ頭':         'Port Mackerel',
  'シオノメ油田':       'Saltspray Rig',
  'Ｂバスパーク':       'Blackbelly Skatepark',
  'ハコフグ倉庫':       'Walleye Warehouse',
  'アロワナモール':     'Arowana Mall',
  'モズク農園':         'Kelp Dome',
  'ネギトロ炭鉱':       'Bluefin Depot',
  'タチウオパーキング': 'Moray Towers',
  'モンガラキャンプ場': 'Camp Triggerfish',
  'ヒラメが丘団地':     'Flounder Heights',
  'マサバ海峡大橋':     'Hammerhead Bridge',
  'キンメダイ美術館':   'Museum d\'Alfonsino',
  'マヒマヒリゾート＆スパ': 'Mahi-Mahi Resort',
  'ショッツル鉱山':     'Piranha Pit',
  'アンチョビットゲームズ': 'Ancho-V Games',
};

function parseMaps(div) {
  var ruleSpan = div.querySelector('span.rule-description');
  var mapSpans = div.querySelectorAll('span.map-name');
  var teamSpans = div.querySelectorAll('span.festival-team-info:not(.festival-team-vs)');
  var ret = {maps: []};
  if (ruleSpan) {
    ret.rulesJP = ruleSpan.textContent;
    ret.rulesEN = rulesNames[ret.rulesJP] || ret.rulesJP;
    ret.rules = {
      jp: ret.rulesJP,
      en: ret.rulesEN,
    };
  } else if (teamSpans.length) {
    ret.rules = {
      jp: 'フェス',
      en: 'Splatfest'
    };
    ret.teams = [];
    for (var i = 0; i < teamSpans.length; i++)
      ret.teams.push(teamSpans[i].textContent);
  } else {
    ret.rules = {
      jp: 'ナワバリバトル',
      en: 'Turf War'
    };
  }
  for (var i = 0; i < mapSpans.length; i++) {
    var entry = {
      nameJP: mapSpans[i].textContent
    };
    entry.nameEN = mapsNames[entry.nameJP] || entry.nameJP;
    entry.name = {
      jp: entry.nameJP,
      en: entry.nameEN
    }
    ret.maps.push(entry);
  }
  return ret;
}

function clearCF() {
  cf.execute({
    a: 'zone_file_purge',
    z: conf.domain,
    url: pre('schedule.json')
  }).catch(function(e) {
    console.log(e);
  });
}

function cacheSchedule(cb, next) {
  if (cachedSchedule.updateTime > Date.now() - 1000 * 10 || (cachedSchedule.schedule && cachedSchedule.schedule[0] && cachedSchedule.schedule[0].endTime > Date.now() + 1000 * 60 * 2))
    return cb(false);

  console.log("Cache is possibly stale; refreshing...");

  jsdom.env('https://splatoon.nintendo.net/schedule', {cookieJar: cookieJar}, function (error, window) {
    if (error)
      return next(error);

    try {
      var mainDiv = window.document.querySelector('div.stage div.contents');
      var fest = !!window.document.querySelector('.festival');
      var schedule = {updateTime: Date.now(), schedule: [], splatfest: fest};

      var year = (new Date()).getUTCFullYear();
      var spans = mainDiv.querySelectorAll('span.stage-schedule');
      var divs = mainDiv.querySelectorAll('div.stage-list');
      for (var i = 0; i < spans.length; i++) {
        var entry = {modes: []};
        var timeArr = RegExp('(\\d{1,2})/(\\d{1,2}) (\\d{1,2}):00 ~ (\\d{1,2})/(\\d{1,2}) (\\d{1,2}):00').exec(spans[i].textContent);
        var startTime = new Date(year, parseInt(timeArr[1], 10) - 1, parseInt(timeArr[2], 10), parseInt(timeArr[3], 10), 0, 0);
        if (startTime.getTime() < Date.now() - 1000 * 60 * 60 * 72)
          startTime.setUTCFullYear(year + 1);
        else if (startTime.getTime() > Date.now() + 1000 * 60 * 60 * 72)
          startTime.setUTCFullYear(year - 1);
        var endTime = new Date(year, parseInt(timeArr[4], 10) - 1, parseInt(timeArr[5], 10), parseInt(timeArr[6], 10), 0, 0);
        if (endTime.getTime() < Date.now() - 1000 * 60 * 60 * 72)
          endTime.setUTCFullYear(year + 1);
        else if (endTime.getTime() > Date.now() + 1000 * 60 * 60 * 72)
          endTime.setUTCFullYear(year - 1);

        entry.startTime = startTime.getTime();
        entry.endTime = endTime.getTime();

        entry.regular = parseMaps(divs[i * 2]);
        entry.modes[0] = entry.regular;
        if (divs[i * 2 + 1]) {
          entry.ranked = parseMaps(divs[i * 2 + 1]);
          entry.modes[1] = entry.ranked;
        }

        schedule.schedule.push(entry);
      }

      var timeout = 10 * 1000;

      var changed = !deepEqual(cachedSchedule.schedule, schedule.schedule);

      cachedSchedule = schedule;

      if (changed) {
        clearCF();
        timeout = cachedSchedule.schedule[0].endTime - Date.now() - 2 * 60 * 1000;
      }

      setTimeout(cacheSchedule, timeout, function(){}, function(){});

      cb(changed);
    } catch (e) {
      return next(e);
    }
  });
};

app.get('/schedule(.json)?', cors(), function (req, res, next) {
  cacheSchedule(function () {
    return res.send(cachedSchedule);
  }, next);
});

app.use(function(err, req, res, next) {
  console.error(err.stack);
  res.status(500).send({'ERROR': 500});
});

cacheSchedule(function(){}, function(){});

app.listen(process.env.PORT ? parseInt(process.env.PORT, 10) : 3000, '127.0.0.1');
