/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// create namespace
if (typeof Mozilla === 'undefined') {
    var Mozilla = {};
}

Mozilla.FxaIframe = (function() {
    'use strict';

    // stores user-supplied config
    var _config;

    // stores event name for GA
    var _gaEventName;

    // remembers if iframe has performed auth handshake
    var _handshake = false;

    // host domain for FxA
    var _host;

    // alternative host domain for FxA within partner distribution
    var _distHost;

    // reference to <iframe> element containing FxA
    var _$iframe;

    // stores full URL to FxA to be used for <iframe> src attribute
    var _src;

    var _removeTrailingSlash = function(host) {
        return (host[host.length - 1] === '/') ? host.substr(0, host.length - 1) : host;
    };

    var _init = function(userConfig) {
        // store user supplied config
        _config = userConfig;

        _host = $('#fxa-iframe-config').data('host');
        _$iframe = $('#fxa');
        _src = _$iframe.data('src');

        // set up postMessage listener
        window.addEventListener('message', _onMessageReceived, true);

        // if specified, pre-populate email address in iframe form
        if (_config.userEmail && /(.+)@(.+)\.(.+){2,}/.test(_config.userEmail)) {
            _src = _src + '&email=' + encodeURIComponent(_config.userEmail);
        }

        // make sure _host URL doesn't have a trailing slash
        _host = _removeTrailingSlash(_host);

        // check user's Fx version to determine FxA iframe experience
        if (Mozilla.Client.FirefoxMajorVersion >= 46) {
            _src = _src.replace('context=iframe', 'context=fx_firstrun_v2');
        }

        // add origin (protocol + hostname + (optional) port) for embed authorization
        _src += '&origin=' + encodeURIComponent(window.location.origin);

        // initialize GA event name
        _gaEventName = _config.gaEventName || 'fxa';

        if (_config.distribution && _config.distribution !== 'default') {
            _distHost = $('#fxa-iframe-config').data(_config.distribution.toLowerCase() + 'Host');
            if (_distHost) {
                _distHost = _removeTrailingSlash(_distHost);
                _src = _src.replace(_host, _distHost);
                _host = _distHost;
            }
        }

        // call iframe to life by setting src attribute
        _$iframe.attr('src', _src);

        // set a timeout to show FxA (error page, most likely) should the ping event fail
        setTimeout(function() {
            if (!_handshake) {
                _showIframe(400);
            }
        }, 2500);
    };

    // resize and ensure visibility of iframe
    var _showIframe = function(height) {
        _$iframe.css('height', height + 'px').addClass('loaded');
    };

    var _sendGAEvent = function(type, extra) {
        var dataLayer = window.dataLayer || [];
        var data = {
            'event': _gaEventName, // user-configurable, defaults to 'fxa'
            'interaction': type
        };

        // merge additional properties if available
        if (extra) {
            $.extend(data, extra);
        }

        dataLayer.push(data);
    };

    var _userCallback = function(callbackName, data) {
        if (typeof _config[callbackName] === 'function') {
            _config[callbackName](data);
        }
    };

    // postMessage communication handlers
    var _onMessageReceived = function(e) {
        // make sure origin is as expected
        if (e.origin !== _host) {
            return;
        }

        var data = JSON.parse(e.data);

        switch (data.command) {
        // iframe has loaded successfully
        case 'loaded':
            _onLoaded(data);
            break;
        // iframe has changed size due to content change
        case 'resize':
            _onResize(data);
            break;
        // user has entered email address or password
        case 'form_engaged':
            _onFormEngaged(data);
            break;
        // user has deleted email address or password
        case 'form_disabled':
            _onFormDisabled(data);
            break;
        // user has chnaged pages within the iframe
        case 'navigated':
            _onNavigated(data);
            break;
        // user has signed up, but not yet verified email
        case 'signup_must_verify':
            _onSignupMustVerify(data);
            break;
        // user has returned to page after verifying email (may never happen)
        case 'verification_complete':
            _onVerificationComplete(data);
            break;
        // user has logged in (instead of signing up)
        case 'login':
            _onLogin(data);
            break;
        }
    };

    var _onLoaded = function(data) {
        // remember iframe has loaded
        _handshake = true;

        _sendGAEvent('fxa-loaded');
        _userCallback('onLoaded', data);
    };

    var _onResize = function(data) {
        // update iframe to accommodate new height
        _showIframe(data.data.height);
        _userCallback('onResize', data);
    };

    var _onFormEngaged = function(data) {
        _userCallback('onFormEngaged', data);
    };

    var _onFormDisabled = function(data) {
        _userCallback('onFormDisabled', data);
    };

    var _onNavigated = function(data) {
        _userCallback('onNavigated', data);
    };

    var _onSignupMustVerify = function(data) {
        // if emailOptIn property is present, send value to GA
        if (data.data.hasOwnProperty('emailOptIn')) {
            _sendGAEvent('email opt-in', { 'label': data.data.emailOptIn });
        }

        _sendGAEvent('fxa-signup');
        _userCallback('onSignupMustVerify', data);
    };

    var _onVerificationComplete = function(data) {
        _sendGAEvent('fxa-verified');
        _userCallback('onVerificationComplete', data);
    };

    var _onLogin = function(data) {
        _sendGAEvent('fxa-signin');

        // ****************************************************************** //
        // ****************************************************************** //
        // If an 'onLogin' handler is supplied, it *must* redirect the user away
        // from the current page! (see below)
        // ****************************************************************** //
        // ****************************************************************** //

        // After a successful login, the FxA iframe, due to the
        // 'haltAfterSignIn=True' parameter, will appear to spin, displaying a
        // "Working..." error message that never goes away (even though the
        // login is successful). Because of this, a redirect *must* happen
        // after the 'login' postMessage.
        if (typeof _config['onLogin'] === 'function') {
            // We are trusting that the 'onLogin' handler does *something* to
            // hide the FxA iframe.
            _userCallback('onLogin', data);
        } else {
            // `?service=sync` is a temporary workaround to avoid an
            // unwanted redirect back to /signin. See bug 1380825.
            Mozilla.Utils.doRedirect(_host + '/settings?service=sync');
        }
    };

    // public properties/methods
    return {
        // Must be called from page specific script to initialize the iframe
        //
        // userConfig: optional object containing any of the following:
        //     gaEventName: string name of GA event (generally customized per
        //         page - defaults to 'fxa')
        //     onLoaded: function called after iframe 'loaded' postMessage
        //     onResize: function called after iframe 'resize' postMessage
        //     onFormEngaged: function called after user has entered information in the form
        //     onFormDisabled: function called after user has removed information from the form
        //     onNavigated: function called after user has submitted a form
        //     onSignupMustVerify: function called after iframe
        //         'signup_must_verify' postMessage
        //     onVerificationComplete: function called after iframe
        //         'verification_complete' postMessage
        //     userEmail: email address to be pre-populated in iframe form
        init: function(userConfig) {
            _init(userConfig || {});
        }
    };
})(window.jQuery, window.Mozilla);
