/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* this is a small standalone abstraction which lets scripts be
 * browserid WSAPI clients.  It handles CSRF token fetching and
 * extraction/resending of cookies.  It also allows one to have
 * any number of "client contexts" which are just objects, and lets
 * you simulated different simultaneous sessions.
 */

const
request = require('request'),
url = require('url'),
querystring = require('querystring');

function injectCookies(ctx, headers) {
  if (ctx.cookieJar && Object.keys(ctx.cookieJar).length) {
    // use the lowercase "cookie" for this or else request overwrites the
    // cookies with its own cookieJar
    // See:
    //     https://github.com/mikeal/request/issues/324
    headers['cookie'] = "";
    for (var k in ctx.cookieJar) {
      headers['cookie'] += k + "=" + ctx.cookieJar[k];
    }
  }
}

function extractCookies(ctx, res) {
  if (ctx.cookieJar === undefined) ctx.cookieJar = {};
  if (res.headers['set-cookie']) {
    res.headers['set-cookie'].forEach(function(cookie) {
      var m = /^([^;]+)(?:;.*)$/.exec(cookie);
      if (m) {
        var x = m[1].split('=');
        ctx.cookieJar[x[0]] = x[1];
      }
    });
  }
}

exports.clearCookies = function(ctx) {
  if (ctx && ctx.cookieJar) delete ctx.cookieJar;
  if (ctx && ctx.session) delete ctx.session;
};

exports.getCookie = function(ctx, which) {
  if (typeof which === 'string') which = new Regex('/^' + which + '$/');
  var cookieNames = Object.keys(ctx.cookieJar);
  for (var i = 0; i < cookieNames.length; i++) {
    if (which.test(cookieNames[i])) return ctx.cookieJar[cookieNames[i]];
  }
  return null;
};

exports.injectCookies = injectCookies;

exports.get = function(cfg, path, context, getArgs, cb) {
  var headers = { };
  injectCookies(context, headers);

  if (typeof getArgs === 'object') {
    path += "?" + querystring.stringify(getArgs);
  }

  request({
    uri: cfg.browserid + path,
    headers: headers,
    followRedirect: true,
    jar: false
  }, function(err, res, body) {
    if (err) {
      console.log("ERROR: wsapi_client.get " + cfg.browserid+path + " -> " + err);
      return cb(err);
    }
    extractCookies(context, res);
    return cb(null, {statusCode: res.statusCode, headers: res.headers, body: body});
  });
};

function withCSRF(cfg, context, cb) {
  if (context.session && context.session.csrf_token) {
    console.log("session already has context");
    return cb(null, context.session.csrf_token);
  }

  exports.get(cfg, '/wsapi/session_context', context, undefined, function(err, res) {
    if (err) return cb(err);
    try {
      if (res.statusCode !== 200) throw 'http error';
      context.session = JSON.parse(res.body);
      context.sessionStartedAt = new Date().getTime();
      return cb(null, context.session.csrf_token);
    } catch(err) {
      console.log('error getting csrf token: ', err);
      return cb(err);
    }
  });
}

exports.getSessionContext = withCSRF;

exports.post = function(cfg, path, context, postArgs, cb) {
  withCSRF(cfg, context, function(err, csrf) {
    if (err) return cb(err);

    var headers = {
      'Content-Type': 'application/json'
    };
    injectCookies(context, headers);

    if (typeof postArgs === 'object') {
      postArgs['csrf'] = csrf;
    }
    var body = JSON.stringify(postArgs);
    headers['Content-Length'] = body.length;

    var req = request({
      uri: cfg.browserid + path,
      headers: headers,
      method: "POST",
      followAllRedirects: true,
      body: body,
      jar: false
    }, function(err, res, body) {
      if (err) {
        console.log("ERROR: wsapi_client.post: " + err);
        return cb(err);
      }
      extractCookies(context, res);
      return cb(null, {statusCode: res.statusCode, headers: res.headers, body: body});
    });
  });
};
