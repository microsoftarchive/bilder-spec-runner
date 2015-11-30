module.exports = function (grunt) {

  'use strict';

  var vm = require('vm');
  var fs = require('fs');
  var path = require('path');
  var assert = require('assert');

  var jquery = require('jquery');
  var jsdom = require('jsdom');
  var xhr = require('xmlhttprequest');

  var chai = require('chai');
  var sinon = require('sinon');
  var Mocha = require('mocha');
  var requirejs = require('requirejs');
  var istanbul = require('istanbul');
  sinon.chai = require('sinon-chai');

  var minimatch = require('minimatch');
  var Minimatch = minimatch.Minimatch;

  var define = requirejs.define;
  var _ = grunt.util._;
  var glob = grunt.file.glob;

  var isTravis = (process.env.TRAVIS === 'true');

  var basicMarkup = '<!doctype html>' +
                    '<html>' +
                      '<head></head>' +
                      '<body></body>' +
                    '</html>';

  // helper for pretty assertion failures inside of asynchronous calls
  // http://stackoverflow.com/questions/11235815/is-there-a-way-to-get-chai-working-with-asynchronous-mocha-tests
  var check = function (done, fn) {
    try {
      fn();
      done();
    }
    catch (e) {
      done(e);
    }
  };

  // Dummies/Mocks for require.js to work
  function noop() { return {}; }
  function fakeLoader(a, b, load) { load(noop); }

  // Instrument files for coverage
  var oldRequireJSLoader = requirejs.load;
  var makeNodeWrapper = requirejs.makeNodeWrapper;
  var exists = fs.existsSync || path.existsSync;
  function instrumentModule (options) {

    return function (context, moduleName, url) {

      options.files = options.files || [];

      // skip files not marked for coverage & other plugin schtuff
      if(options.files.indexOf(url) === -1 || !exists(url)) {
        return oldRequireJSLoader.call(requirejs, context, moduleName, url);
      }

      // Load file from FS,
      var contents = fs.readFileSync(url, 'utf8');

      // Instrument the code
      var instrumenter = new istanbul.Instrumenter();
      contents = instrumenter.instrumentSync(contents, url);

      // Wrap it for node.js
      contents = makeNodeWrapper(contents);

      // execute it in the context of requirejs
      try {
        vm.runInThisContext(contents, fs.realpathSync(url));
      } catch (e) {
         throw new Error('Failed: "' + moduleName + '"\n' + e);
      }

      // mark module as loaded
      context.completeLoad(moduleName);
    };
  }

  // patch the context with some globals & stuff
  function patchMochaContext (mocha) {

    mocha.suite.on('pre-require', function(context) {

      // use a fresh new dom for every test
      var document = jsdom.jsdom(basicMarkup);
      var win = document.defaultView;
      win.document = document;
      win.navigator = context.navigator = {
        'userAgent': 'Bilder Test Runner',
        'appVersion': '1.0.0'
      };

      var $ = jquery(win);

      // enhance chai's flavour
      chai.use(sinon.chai);

      // Attach globals to all the contexts
      function fixContext(ctx) {

        // Augment BOM
        ctx.window = win;
        ctx.document = win.document;

        ctx.$ = ctx.window.$ = $;

        // make "requirejs" a global in specs running in nodejs
        ctx.requirejs = ctx.require = requirejs;
        ctx.nodeRequire = require;

        // make chai functions available
        ctx.should = chai.should();
        ctx.expect = chai.expect;
        ctx.assert = assert;

        // make sinon available
        ctx.sinon = sinon;

        // manually load sinon's fake xhr module
        // TODO: is this really the best way to load it?
        ctx.XMLHttpRequest = ctx.window.XMLHttpRequest = xhr.XMLHttpRequest;

        // make requirejs methods available
        ctx.define = define;

        // Let specs use underscore
        ctx._ = _;

        // Specs are in nodejs
        ctx.isNode = true;

        // Specs are on travis
        ctx.isTravis = isTravis;

        // assertion helper
        ctx.check = check;
      }

      // fix the main suite context first
      fixContext(context);

      // also make all this stuff available on beforeEach of these suites
      mocha.suite.setMaxListeners(0);
      mocha.suite.on('suite', function(suite) {
        suite.setMaxListeners(0);
        suite.on('beforeEach', function(hook) {
          fixContext(hook.ctx);
        });
      });
    });
  }

  grunt.registerTask(
    'specs/mocha',
    'Node based spec-runner for mocha',
    function () {

    var options = this.options({
      'base': '',
      'glob': '**/*.spec.js',
      'timeout': 1000,
      'ui': 'bdd',
      'reporter': 'spec',
      'globals': ['_', '$', 'check'],
      'require': {
        'base': 'public',
        'paths': {}
      },
      'mocks': {},
      'fake_plugins': [],
      'fake_modules': [],
      'coverage': {}
    });

    // Stub requirejs plugins
    options.fake_plugins.forEach(function (pluginName) {
      define(pluginName, { 'load': fakeLoader });
    });

    // Fake some requirejs modules
    options.fake_modules.forEach(function (pluginName) {
      define(pluginName, noop);
    });

    // Async task here
    var done = this.async();

    // Create a new spec-runner
    var mocha = new Mocha();

    // Allow certain globals in mocha
    mocha.globals(options.globals);

    // Configure Timeout, Mocha UI & Reporter
    mocha.timeout(options.timeout);
    mocha.ui(options.ui);
    mocha.reporter(options.reporter);

    var paths = {};

    // Make mock paths absolute
    var mocks = options.mocks || {};
    if (mocks.base && mocks.paths) {
      Object.keys(mocks.paths).forEach(function (name) {
        paths[name] = path.resolve(options.base, mocks.base, mocks.paths[name]);
      });
    }

    // fix requirejs paths
    var rjs = options.require || {};
    if (rjs.base && rjs.paths) {
      Object.keys(rjs.paths).forEach(function (name) {
        paths[name] = path.resolve(options.base, rjs.base, rjs.paths[name]);
      });
    }

    // find modules in the app folder
    requirejs.config({
      'baseUrl': path.resolve(options.base, options.require.base),
      'paths': paths,
      'shim': options.require.shim || {}
    });

    // Make paths absolute for files marked for coverage
    var oFiles = options.coverage.files;
    if (oFiles) {
      var cFiles = [];
      var requireBase = options.require.base;
      oFiles.forEach(function(rule) {
        rule = path.resolve(options.base, requireBase, rule);
        cFiles.push.apply(cFiles, glob.sync(rule));
      });
      options.coverage.files = cFiles;
    }

    // Override requirejs.load for coverage generation
    if (options.coverage.files) {
      requirejs.load = instrumentModule(options.coverage);
    }

    // Path the context
    patchMochaContext(mocha);

    // populate files
    var oGlob = options.glob;
    var globRules = Array.isArray(oGlob) ? oGlob : [oGlob];
    var files = [];
    globRules.forEach(function (rule) {
      rule = path.resolve(options.base, rule);
      files.push.apply(files, glob.sync(rule));
    });

    // ignore files
    if (options.ignore) {
      var ignore = options.ignore.slice(0);
      var pattern, matcher;
      var filter = function (filepath) {
        return !matcher.match(filepath);
      };
      while (ignore.length) {
        pattern = ignore.shift();
        matcher = new Minimatch(pattern, {
          'matchBase': true
        });
        files = files.filter(filter);
      }
    }

    mocha.files = files;

    // add support for grepping specs
    if (this.args.length && mocha.files.length) {
      mocha.grep(this.args[0]);
    }

    function onDone (count) {

      if (global.__coverage__) {

        // Process the coverage
        var collector = new istanbul.Collector();
        collector.add(global.__coverage__);

        // Generate the report
        ['text-summary', 'html'].forEach(function (type) {
          istanbul.Report.create(type, {
            'dir': options.coverage.output_dir || ''
          }).writeReport(collector, true);
        });
      }

      // Stop fataly on any failed specs
      if (count) {
        grunt.fatal(count + ' failures.');
      } else {
        done();
      }
    }

    // Run it
    try {
      mocha.run(onDone);
    } catch (e) {
      console.log(e.message, e.stack);
    }

  });
};
