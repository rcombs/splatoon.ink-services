"use strict";

var deepEqual = require('deep-equal'),
    express = require('express'),
    request = require('request'),
    xml2js = require('xml2js'),
    cors = require('cors'),
    jsdom = require('jsdom'),
    CookieJar = require('tough-cookie').CookieJar,
    FileCookieStore = require('tough-cookie-filestore'),
    jwtDecode = require('jwt-decode');

var conf = require(process.argv[2] || './config.json');

function pre(s) {
  return 'https://' + conf.domain + conf.prefix + s;
}

var cookieStore = new FileCookieStore(conf.cookiePath);
var cookieStore2 = new FileCookieStore(conf.cookiePath2);
var cookieJar = new CookieJar(cookieStore);

request = request.defaults({ jar : request.jar(cookieStore2) });

var CF = require('cloudflare'),
    cf = new CF(conf.cf);

var app = express();

conf.threads && conf.threads.forEach(function(thread) {
  var board = thread.board || 'vg';
  thread.lastCheck = 0;
  thread.lastThreadNo = 0;
  app.get((thread.endpoint || '/ink/'), function (req, res, next) {
    if (thread.lastCheck > Date.now() - 1000 * 30)
      return res.location('https://boards.4chan.org/' + board + '/thread/' + thread.lastThreadNo).status(307).send('FOUND THREAD\n');

    request({url: 'https://a.4cdn.org/' + board + '/catalog.json', json: true}, function (error, response, body) {
      if (error)
        return next(error);

      try {
        var chosenThread;

        for (var i = 0; i < body.length; i++) {
          var page = body[i];
          for (var j = 0; j < page.threads.length; j++) {
            var thd = page.threads[j];
            if ((thd.sub.startsWith(thread.searchString || thread.endpoint || '/ink/') ||
                 thd.sub.endsWith  (thread.searchString || thread.endpoint || '/ink/')) &&
                 thd.replies >= (thread.minReplies || 10)) {
              chosenThread = thd;
              break;
            }
          }
          if (chosenThread)
            break;
        }

        if (!chosenThread) {
          if (conf.deadThreadUrl)
            return res.location(conf.deadThreadUrl).status(307).send('RIP');
          else
            return res.status(503).send('NO THREAD FOUND');
        }

        thread.lastThreadNo = chosenThread.no;
        thread.lastCheck = Date.now();
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

var cachedSchedule2 = {
  updateTime: 0,
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

function clearCF(files) {
  cf.zones.purgeCache(conf.zone, {
    files: files
  }).catch(function(e) {
    console.error(e);
  });
}

function cacheSchedule(cb, next) {
  if (cachedSchedule.updateTime > Date.now() - 1000 * 10 || (cachedSchedule.schedule && cachedSchedule.schedule[0] && cachedSchedule.schedule[0].endTime > Date.now() + 1000 * 60 * 2))
    return cb();

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
        clearCF([pre('schedule.json'), pre('schedule')]);
        timeout = cachedSchedule.schedule[0].endTime - Date.now() - 2 * 60 * 1000;
      }

      setTimeout(cacheSchedule, timeout, function(){}, function(){});

      cb(changed);
    } catch (e) {
      return next(e);
    }
  });
};

var naIdToken = {
  val: "",
  exp: 0
};

function refreshNaIDToken(cb, next) {
  request({
    uri: 'https://accounts.nintendo.com/connect/1.0.0/api/token',
    json: true,
    body: conf.tokenJSON,
    method: 'POST'
  }, function (err, res, body) {
    if (err)
      return next(err);
    if (!body || body.token_type !== 'Bearer' || !body.id_token)
      return next('Bad token response');
    var token;
    try {
      token = jwtDecode(body.id_token);
    } catch (e) {
      return next(e);
    }
    if (!token || !token.exp)
      return next('Bad service token');
    naIdToken.exp = token.exp * 1000;
    naIdToken.val = body.id_token;
    return refreshServiceToken(cb, next, true);
  });
}

var serviceToken = {
  val: "",
  exp: 0
};

function refreshServiceToken(cb, next, retry) {
  if (naIdToken.exp < Date.now() - 1000 * 30) {
    if (retry)
      return next('Recursion at refreshServiceToken');
    else
      return refreshNaIDToken(cb, next);
  }

  request({
    uri: 'https://api-lp1.znc.srv.nintendo.net/v1/Account/Login',
    headers: {authorization: 'Bearer', '%3Aauthority': 'api-lp1.znc.srv.nintendo.net', 'x-platform': 'iOS', 'x-productversion': '1.0.4'},
    json: true,
    body: {parameter: {
      language: "en-US",
      naBirthday: conf.naBirthday,
      naCountry: conf.naCountry,
      naIdToken: naIdToken.val
    }},
    method: 'POST'
  }, function (err, res, body) {
    if (err)
      return next(err);
    if (!body || body.status !== 0 || !body.result || !body.result.webApiServerCredential || !body.result.webApiServerCredential.accessToken)
      return next('Bad Login response: ' + JSON.stringify(body));
    var token;
    try {
      token = jwtDecode(body.result.webApiServerCredential.accessToken);
    } catch (e) {
      return next(e);
    }
    if (!token || !token.exp)
      return next('Bad service token');
    serviceToken.exp = token.exp * 1000;
    serviceToken.val = body.result.webApiServerCredential.accessToken;
    return refreshGameWebToken(cb, next, true);
  });
}

var gameWebToken = {
  val: "",
  exp: 0
};

function refreshGameWebToken(cb, next, retry) {
  if (serviceToken.exp < Date.now() - 1000 * 30) {
    if (retry)
      return next('Recursion at refreshGameWebToken');
    else
      return refreshServiceToken(cb, next);
  }

  request({
    uri: 'https://api-lp1.znc.srv.nintendo.net/v1/Game/GetWebServiceToken',
    headers: {authorization: 'Bearer ' + serviceToken.val, 'x-platform': 'iOS', 'x-productversion': '1.0.4'},
    json: true,
    body: {parameter: {id: 5741031244955648}},
    method: 'POST'
  }, function (err, res, body) {
    if (err)
      return next(err);
    if (!body || body.status !== 0 || !body.result || !body.result.accessToken)
      return next('Bad GetWebServiceToken response: ' + JSON.stringify(body));
    var token;
    try {
      token = jwtDecode(body.result.accessToken);
    } catch (e) {
      return next(e);
    }
    if (!token || !token.exp)
      return next('Bad gameWebToken');
    gameWebToken.exp = token.exp * 1000;
    gameWebToken.val = body.result.accessToken;
    return refreshCookie(cb, next, true);
  });
}

function refreshCookie(cb, next, retry) {
  if (gameWebToken.exp < Date.now() - 1000 * 30) {
    if (retry)
      return next('Recursion at refreshCookie');
    else
      return refreshGameWebToken(cb, next);
  }

  request({
    uri: 'https://app.splatoon2.nintendo.net/?lang=en-US',
    headers: {'x-gamewebtoken': gameWebToken.val}
  }, function (err, res, body) {
    if (err)
      return next(err);
    return refreshStages2(cb, next);
  });
}

function refreshStages2(cb, next) {
  request({uri: 'https://app.splatoon2.nintendo.net/api/schedules', json: true}, function (err, res, body) {
    if (err)
      return next(err);
    if (!body)
      return next('bad schedule2');
    var schedule = {updateTime: Date.now(), modes: {}, splatfests: []};
    var firstMode;
    for (var mode in body) {
      if (!body[mode])
        continue;
      firstMode = mode;
      var modeA = [];
      for (var i = 0; i < body[mode].length; i++) {
        var entry = body[mode][i];
        var fEntry = {startTime: entry.start_time, endTime: entry.end_time, maps: [], rule: entry.rule};
        if (entry.stage_a) fEntry.maps.push(entry.stage_a.name);
        if (entry.stage_b) fEntry.maps.push(entry.stage_b.name);
        if (entry.stage_c) fEntry.maps.push(entry.stage_c.name);
        modeA.push(fEntry);
      }
      schedule.modes[mode] = modeA;
    }

    request({uri: 'https://app.splatoon2.nintendo.net/api/festivals/active', json: true}, function (err2, res2, body2) {
      if (err2)
        return next(err2);
      if (body2 && body2.festivals) {
        for (var i = 0; i < body2.festivals.length; i++) {
          var entry = body2.festivals[i];
          var fEntry = {colors: entry.colors, names: entry.names, times: entry.times};
          if (entry.special_stage)
            fEntry.specialStage = entry.special_stage.name;
          schedule.splatfests.push(fEntry);
        }
      }
      var timeout = 10 * 1000;

      var changed = !deepEqual(cachedSchedule2.modes, schedule.modes) || !deepEqual(cachedSchedule2.splatfests, schedule.splatfests);

      cachedSchedule2 = schedule;

      if (changed) {
        clearCF([pre('schedule2.json'), pre('schedule2')]);
        if (firstMode && cachedSchedule2.modes[firstMode] && cachedSchedule2.modes[firstMode][0])
          timeout = cachedSchedule2.modes[firstMode][0].endTime * 1000 - Date.now() - 2 * 60 * 1000;
      }

      setTimeout(cacheSchedule2, timeout, function(){}, function(){});

      cb(changed);
    });
  });
}

function cacheSchedule2(cb, next) {
  if (cachedSchedule2.updateTime > Date.now() - 1000 * 10 || (cachedSchedule2.schedule && cachedSchedule2.schedule[0] && cachedSchedule2.schedule[0].endTime * 1000 > Date.now() + 1000 * 60 * 2))
    return cb();

  console.log("Cache2 is possibly stale; refreshing...");

  cookieStore.findCookie('app.splatoon2.nintendo.net', '/', 'iksm_session', function (err, cookie) {
    if (err)
      return next(err);
    if (!cookie || cookie.expiryTime() < Date.now() - 1000 * 30)
      return refreshCookie(cb, next);
    return refreshStages2(cb, next);
  });
}

app.get('/schedule(.json)?', cors(), function (req, res, next) {
  cacheSchedule(function () {
    return res.send(cachedSchedule);
  }, next);
});

app.get('/schedule2(.json)?', cors(), function (req, res, next) {
  cacheSchedule2(function () {
    return res.send(cachedSchedule2);
  }, next);
});

app.use(function(err, req, res, next) {
  console.error(err && err.stack ? err.stack : err);
  res.status(500).send({'ERROR': 500});
});

cacheSchedule(function(){}, function(err){console.error(err && err.stack ? err.stack : err)});
cacheSchedule2(function(){}, function(err){console.error(err && err.stack ? err.stack : err)});

app.listen(process.env.PORT ? parseInt(process.env.PORT, 10) : 3000, '127.0.0.1');
