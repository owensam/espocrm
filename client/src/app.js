/************************************************************************
 * This file is part of EspoCRM.
 *
 * EspoCRM - Open Source CRM application.
 * Copyright (C) 2014-2021 Yurii Kuznietsov, Taras Machyshyn, Oleksii Avramenko
 * Website: https://www.espocrm.com
 *
 * EspoCRM is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * EspoCRM is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with EspoCRM. If not, see http://www.gnu.org/licenses/.
 *
 * The interactive user interfaces in modified source and object code versions
 * of this program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU General Public License version 3.
 *
 * In accordance with Section 7(b) of the GNU General Public License version 3,
 * these Appropriate Legal Notices must retain the display of the "EspoCRM" word.
 ************************************************************************/

define(
    'app',
    [
        'ui',
        'utils',
        'acl-manager',
        'cache',
        'storage',
        'models/settings',
        'language',
        'metadata',
        'field-manager',
        'models/user',
        'models/preferences',
        'model-factory',
        'collection-factory',
        'pre-loader',
        'controllers/base',
        'router',
        'date-time',
        'layout-manager',
        'theme-manager',
        'session-storage',
        'view-helper',
        'web-socket-manager',
        'ajax',
        'number',
        'page-title',
    ],
    function (
        Ui,
        Utils,
        AclManager,
        Cache,
        Storage,
        Settings,
        Language,
        Metadata,
        FieldManager,
        User,
        Preferences,
        ModelFactory,
        CollectionFactory,
        PreLoader,
        BaseController,
        Router,
        DateTime,
        LayoutManager,
        ThemeManager,
        SessionStorage,
        ViewHelper,
        WebSocketManager,
        Ajax,
        NumberUtil,
        PageTitle
    ) {

    var App = function (options, callback) {
        options = options || {};

        this.id = options.id || 'espocrm-application-id';

        this.useCache = options.useCache || this.useCache;
        this.apiUrl = options.apiUrl || this.apiUrl;
        this.basePath = options.basePath || '';
        this.ajaxTimeout = options.ajaxTimeout || 0;

        this.initCache(options)
            .then(() => this.init(options, callback));
    };

    _.extend(App.prototype, {

        useCache: false,

        user: null,

        preferences: null,

        settings: null,

        metadata: null,

        language: null,

        fieldManager: null,

        cache: null,

        loader: null,

        apiUrl: 'api/v1',

        auth: null,

        baseController: null,

        controllers: null,

        router: null,

        modelFactory: null,

        collectionFactory: null,

        viewFactory: null,

        viewLoader: null,

        viewHelper: null,

        masterView: 'views/site/master',

        responseCache: null,

        initCache: function (options) {
            let cacheTimestamp = options.cacheTimestamp || null;
            let storedCacheTimestamp = null;

            if (this.useCache) {
                this.cache = new Cache(cacheTimestamp);

                storedCacheTimestamp = this.cache.getCacheTimestamp();

                if (cacheTimestamp) {
                    this.cache.handleActuality(cacheTimestamp);
                }
                else {
                    this.cache.storeTimestamp();
                }
            }

            let handleActuality = () => {
                if (
                    !cacheTimestamp ||
                    !storedCacheTimestamp ||
                    cacheTimestamp !== storedCacheTimestamp
                ) {
                    return caches.delete('espo');
                }

                return new Promise(resolve => resolve());
            };

            return new Promise(resolve => {
                if (!this.useCache) {
                    resolve();
                }

                if (!window.caches) {
                    resolve();
                }

                handleActuality()
                    .then(() => caches.open('espo'))
                    .then(responseCache => {
                        this.responseCache = responseCache;
                    })
                    .then(() => resolve())
            });
        },

        init: function (options, callback) {
            this.appParams = {};
            this.controllers = {};

            this.loader = Espo.loader;

            this.loader.responseCache = this.responseCache;

            this.loader.basePath = this.basePath;

            this.storage = new Storage();
            this.sessionStorage = new SessionStorage();

            this.loader.cache = this.cache;

            if (this.useCache && !this.loader.cacheTimestamp && options.cacheTimestamp) {
                this.loader.cacheTimestamp = options.cacheTimestamp;
            }

            this.setupAjax();

            this.settings = new Settings(null);
            this.language = new Language(this.cache);
            this.metadata = new Metadata(this.cache);
            this.fieldManager = new FieldManager();

            Promise
            .all([
                new Promise(resolve => {
                    this.settings.load(() => resolve());
                }),
                new Promise(resolve => {
                    this.language.load(() => resolve(), false, true);
                })
            ])
            .then(() => {
                this.loader.addLibsConfig(this.settings.get('jsLibs') || {});

                this.user = new User();

                this.preferences = new Preferences();

                this.preferences.settings = this.settings;

                this.acl = this.createAclManager();

                this.fieldManager.acl = this.acl;

                this.themeManager = new ThemeManager(this.settings, this.preferences, this.metadata);

                this.modelFactory = new ModelFactory(this.loader, this.metadata, this.user);

                this.collectionFactory = new CollectionFactory(this.loader, this.modelFactory);

                if (this.settings.get('useWebSocket')) {
                    this.webSocketManager = new WebSocketManager(this.settings);
                }

                this.initUtils();
                this.initView();
                this.initBaseController();

                this.preLoader = new PreLoader(this.cache, this.viewFactory, this.basePath);

                this.preLoad(() => {
                    callback.call(this, this);
                });
            });
        },

        start: function () {
            this.initAuth();

            if (!this.auth) {
                this.baseController.login();
            }
            else {
                this.initUserData(null, () => {
                    this.onAuth.call(this);
                });
            }

            this.on('auth', this.onAuth, this);
        },

        onAuth: function () {
            this.metadata.load(() => {
                this.fieldManager.defs = this.metadata.get('fields');
                this.fieldManager.metadata = this.metadata;

                this.settings.defs = this.metadata.get('entityDefs.Settings') || {};
                this.user.defs = this.metadata.get('entityDefs.User');
                this.preferences.defs = this.metadata.get('entityDefs.Preferences');
                this.viewHelper.layoutManager.userId = this.user.id;

                if (this.themeManager.isUserTheme()) {
                    this.loadStylesheet();
                }

                if (this.webSocketManager) {
                    this.webSocketManager.connect(this.auth, this.user.id);
                }

                let promiseList = [];
                let aclImplementationClassMap = {};

                let clientDefs = this.metadata.get('clientDefs') || {};

                Object.keys(clientDefs).forEach(scope => {
                    var o = clientDefs[scope];

                    var implClassName = (o || {})[this.aclName || 'acl'];

                    if (implClassName) {
                        promiseList.push(
                            new Promise(resolve => {
                                this.loader.load(implClassName, implClass => {
                                    aclImplementationClassMap[scope] = implClass;

                                    resolve();
                                });
                            })
                        );
                    }
                });

                if (!this.themeManager.isApplied() && this.themeManager.isUserTheme()) {
                    promiseList.push(
                        new Promise(resolve => {
                            (function check (i) {
                                i = i || 0;

                                if (!this.themeManager.isApplied()) {
                                    if (i === 50) {
                                        resolve();

                                        return;
                                    }

                                    setTimeout(check.bind(this, i + 1), 10);

                                    return;
                                }

                                resolve();
                            }).call(this);
                        })
                    );
                }

                Promise
                    .all(promiseList)
                    .then(() => {
                        this.acl.implementationClassMap = aclImplementationClassMap;

                        this.initRouter();
                    });
            });
        },

        initRouter: function () {
            let routes = this.metadata.get(['app', 'clientRoutes']) || {};

            this.router = new Router({routes: routes});

            this.viewHelper.router = this.router;

            this.baseController.setRouter(this.router);

            this.router.confirmLeaveOutMessage = this.language.translate('confirmLeaveOutMessage', 'messages');
            this.router.confirmLeaveOutConfirmText = this.language.translate('Yes');
            this.router.confirmLeaveOutCancelText = this.language.translate('Cancel');

            this.router.on('routed', params => this.doAction(params));

            try {
                Backbone.history.start({
                    root: window.location.pathname
                });
            }
            catch (e) {
                Backbone.history.loadUrl();
            }
        },

        doAction: function (params) {
            this.trigger('action', params);

            this.baseController.trigger('action');

            this.getController(params.controller, controller => {
                try {
                    controller.doAction(params.action, params.options);

                    this.trigger('action:done');
                }
                catch (e) {
                    console.error(e);

                    switch (e.name) {
                        case 'AccessDenied':
                            this.baseController.error403();

                            break;

                        case 'NotFound':
                            this.baseController.error404();

                            break;

                        default:
                            throw e;
                    }
                }
            });
        },

        initBaseController: function () {
            this.baseController = new BaseController({}, this.getControllerInjection());

            this.viewHelper.baseController = this.baseController;
        },

        getControllerInjection: function () {
            return {
                viewFactory: this.viewFactory,
                modelFactory: this.modelFactory,
                collectionFactory: this.collectionFactory,
                settings: this.settings,
                user: this.user,
                preferences: this.preferences,
                acl: this.acl,
                cache: this.cache,
                router: this.router,
                storage: this.storage,
                metadata: this.metadata,
                dateTime: this.dateTime,
            };
        },

        getController: function (name, callback) {
            if (!(name || false)) {
                callback(this.baseController);

                return;
            }

            if (name in this.controllers) {
                callback(this.controllers[name]);

                return;
            }

            try {
                let className = this.metadata.get('clientDefs.' + name + '.controller');

                if (!className) {
                    let module = this.metadata.get('scopes.' + name + '.module');

                    className = Utils.composeClassName(module, name, 'controllers');
                }

                Espo.require(
                    className,
                    controllerClass => {
                        var injections = this.getControllerInjection();

                        injections.baseController = this.baseController;

                        this.controllers[name] = new controllerClass(this.baseController.params, injections);
                        this.controllers[name].name = name;
                        this.controllers[name].masterView = this.masterView;

                        callback(this.controllers[name]);
                    },
                    this,
                    () => this.baseController.error404()
                );

                return;
            }
            catch (e) {
                this.baseController.error404();
            }
        },

        preLoad: function (callback) {
            this.preLoader.load(callback, this);
        },

        initUtils: function () {
            this.dateTime = new DateTime();

            this.modelFactory.dateTime = this.dateTime;

            this.dateTime.setSettingsAndPreferences(this.settings, this.preferences);

            this.numberUtil = new NumberUtil(this.settings, this.preferences);
        },

        createAclManager: function () {
            return new AclManager(this.user, null, this.settings.get('aclAllowDeleteCreated'));
        },

        initView: function () {
            let helper = this.viewHelper = new ViewHelper();

            // @todo Use `helper.container`.

            helper.layoutManager = new LayoutManager({cache: this.cache, applicationId: this.id});
            helper.settings = this.settings;
            helper.config = this.settings;
            helper.user = this.user;
            helper.preferences = this.preferences;
            helper.acl = this.acl;
            helper.modelFactory = this.modelFactory;
            helper.collectionFactory = this.collectionFactory;
            helper.storage = this.storage;
            helper.dateTime = this.dateTime;
            helper.language = this.language;
            helper.metadata = this.metadata;
            helper.fieldManager = this.fieldManager;
            helper.cache = this.cache;
            helper.storage = this.storage;
            helper.themeManager = this.themeManager;
            helper.sessionStorage = this.sessionStorage;
            helper.basePath = this.basePath;
            helper.appParams = this.appParams;
            helper.webSocketManager = this.webSocketManager;
            helper.numberUtil = this.numberUtil;
            helper.pageTitle = new PageTitle(this.settings);

            this.viewLoader = (viewName, callback) => {
                require(Utils.composeViewClassName(viewName), callback);
            };

            var getResourceInnerPath = function (type, name) {
                let path = null;

                switch (type) {
                    case 'template':
                        if (~name.indexOf('.')) {
                            console.warn(name + ': template name should use slashes for a directory separator.');
                        }

                        path = 'res/templates/' + name.split('.').join('/') + '.tpl';

                        break;

                    case 'layoutTemplate':
                        path = 'res/layout-types/' + name + '.tpl';

                        break;

                    case 'layout':
                        path = 'res/layouts/' + name + '.json';

                        break;
                }

                return path;

            }.bind(this);

            var getResourcePath = (type, name) => {
                if (name.indexOf(':') !== -1) {
                    let arr = name.split(':');

                    name = arr[1];

                    var mod = arr[0];

                    if (mod === 'custom') {
                        return 'client/custom/' + getResourceInnerPath(type, name);
                    }

                    return 'client/modules/' + mod + '/' + getResourceInnerPath(type, name);
                }

                return 'client/' + getResourceInnerPath(type, name);
            };

            this.viewFactory = new Bull.Factory({
                useCache: false,
                defaultViewName: 'views/base',
                helper: helper,
                viewLoader: this.viewLoader,
                resources: {
                    loaders: {
                        'template': (name, callback) => {
                            var path = getResourcePath('template', name);

                            this.loader.load('res!' + path, callback);
                        },
                        'layoutTemplate': (name, callback) => {
                            var path = getResourcePath('layoutTemplate', name);

                            this.loader.load('res!' + path, callback);
                        },
                    },
                },
            });
        },

        initAuth: function () {
            this.auth = this.storage.get('user', 'auth') || null;

            this.baseController.on('login', data => {
                this.auth = Base64.encode(data.auth.userName  + ':' + data.auth.token);

                this.storage.set('user', 'auth', this.auth);

                this.setCookieAuth(data.auth.userName, data.auth.token);

                this.initUserData(data, () => this.trigger('auth'));
            });

            this.baseController.on('logout', () => this.logout());
        },

        logout: function () {
            if (this.auth) {
                let arr = Base64.decode(this.auth).split(':');

                if (arr.length > 1) {
                    Ajax.postRequest('App/action/destroyAuthToken', {
                        token: arr[1]
                    });
                }
            }

            if (this.webSocketManager) {
                this.webSocketManager.close();
            }

            this.auth = null;

            this.user.clear();
            this.preferences.clear();

            this.acl.clear();

            this.storage.clear('user', 'auth');

            this.doAction({action: 'login'});

            this.unsetCookieAuth();

            xhr = new XMLHttpRequest;

            xhr.open('GET', this.basePath + this.apiUrl + '/');

            xhr.setRequestHeader('Authorization', 'Basic ' + Base64.encode('**logout:logout'));

            xhr.send('');

            xhr.abort();

            this.loadStylesheet();
        },

        loadStylesheet: function () {
            if (!this.metadata.get(['themes'])) {
                return;
            }

            let stylesheetPath = this.basePath + this.themeManager.getStylesheet();

            $('#main-stylesheet').attr('href', stylesheetPath);
        },

        setCookieAuth: function (username, token) {
            var date = new Date();

            date.setTime(date.getTime() + (1000 * 24*60*60*1000));

            document.cookie = 'auth-username='+username+'; SameSite=Lax; expires='+date.toGMTString()+'; path=/';
            document.cookie = 'auth-token='+token+'; SameSite=Lax; expires='+date.toGMTString()+'; path=/';
        },

        unsetCookieAuth: function () {
            document.cookie = 'auth-username' + '=; SameSite=Lax; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=/';
            document.cookie = 'auth-token' + '=; SameSite=Lax; expires=Thu, 01 Jan 1970 00:00:01 GMT; path=/';
        },

        initUserData: function (options, callback) {
            options = options || {};

            if (this.auth === null) {
                return;
            }

            new Promise(resolve => {
                if (options.user) {
                    resolve();

                    return;
                };

                this.requestUserData(data => {
                    options = data;

                    resolve();
                });
            })
            .then(
                new Promise(resolve => {
                    this.language.name = options.language;

                    this.language.load(() => resolve());
                })
            )
            .then(() => {
                this.dateTime.setLanguage(this.language);

                let userData = options.user || null;
                let preferencesData = options.preferences || null;
                let aclData = options.acl || null;

                let settingData = options.settings || {};

                this.user.set(userData);
                this.preferences.set(preferencesData);

                this.settings.set(settingData);
                this.acl.set(aclData);

                for (var param in options.appParams) {
                    this.appParams[param] = options.appParams[param];
                }

                if (!this.auth) {
                    return;
                }

                let xhr = new XMLHttpRequest();

                xhr.open('GET', this.basePath + this.apiUrl + '/');

                xhr.setRequestHeader('Authorization', 'Basic ' + this.auth);

                xhr.onreadystatechange = () => {
                    if (xhr.readyState === XMLHttpRequest.DONE && xhr.status === 200) {

                        let arr = Base64.decode(this.auth).split(':');

                        this.setCookieAuth(arr[0], arr[1]);

                        callback();
                    }

                    if (xhr.readyState === XMLHttpRequest.DONE && xhr.status === 401) {
                        Ui.error('Auth error');
                    }
                };

                xhr.send('');
            });
        },

        requestUserData: function (callback) {
            Ajax
                .getRequest('App/user')
                .then(callback);
        },

        setupAjax: function () {
            $.ajaxSetup({
                beforeSend: (xhr, options) => {
                    if (!options.local && this.apiUrl) {
                        options.url = Utils.trimSlash(this.apiUrl) + '/' + options.url;
                    }

                    if (!options.local && this.basePath !== '') {
                        options.url = this.basePath + options.url;
                    }

                    if (this.auth !== null) {
                        xhr.setRequestHeader('Authorization', 'Basic ' + this.auth);
                        xhr.setRequestHeader('Espo-Authorization', this.auth);
                        xhr.setRequestHeader('Espo-Authorization-By-Token', true);
                    }

                },
                dataType: 'json',
                timeout: this.ajaxTimeout,
                contentType: 'application/json',
            });

            $(document).ajaxError((event, xhr, options) => {
                if (xhr.errorIsHandled) {
                    return;
                }

                let statusReason = xhr.getResponseHeader('X-Status-Reason');

                let msg;

                switch (xhr.status) {
                    case 0:
                        if (xhr.statusText === 'timeout') {
                            Ui.error(this.language.translate('Timeout'));
                        }

                        break;

                    case 200:
                        Ui.error(this.language.translate('Bad server response'));
                        console.error('Bad server response: ' + xhr.responseText);

                        break;

                    case 401:
                        if (!options.login) {
                            if (this.auth) {
                                this.logout();
                            }
                            else {
                                console.error('Error 401: Unauthorized.');
                            }
                        }

                        break;

                    case 403:
                        if (options.main) {
                            this.baseController.error403();
                        }
                        else {
                            msg = this.language.translate('Error') + ' ' + xhr.status;

                            msg += ': ' + this.language.translate('Access denied');

                            if (statusReason) {
                                msg += ': ' + statusReason;
                            }

                            Ui.error(msg);
                        }

                        break;

                    case 400:
                        msg = this.language.translate('Error') + ' ' + xhr.status;

                        msg += ': ' + this.language.translate('Bad request');

                        if (statusReason) {
                            msg += ': ' + statusReason;
                        }

                        Ui.error(msg);

                        break;

                    case 404:
                        if (options.main) {
                            this.baseController.error404();
                        }
                        else {
                            msg = this.language.translate('Error') + ' ' + xhr.status;

                            msg += ': ' + this.language.translate('Not found');

                            Ui.error(msg);
                        }

                        break;

                    default:
                        msg = this.language.translate('Error') + ' ' + xhr.status;

                        if (statusReason) {
                            msg += ': ' + statusReason;
                        }

                        Ui.error(msg);
                }

                if (statusReason) {
                    console.error('Server side error '+xhr.status+': ' + statusReason);
                }
            });
        },

    }, Backbone.Events);

    App.extend = Backbone.Router.extend;

    return App;
});
