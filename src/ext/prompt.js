/**
 * ## User Input Prompt extension
 *
 * Provides customizable modal prompts for gathering user input with support for autocompletion, validation, and
 * specialized input types. Includes built-in prompt types for navigation (goto line), command palette, and mode
 * selection, with extensible architecture for custom prompt implementations.
 *
 * **Built-in Prompt Types:**
 * - `gotoLine`: Navigate to specific line numbers with selection support
 * - `commands`: Command palette with searchable editor commands and shortcuts
 * - `modes`: Language mode selector with filtering capabilities
 *
 * **Usage:**
 * ```javascript
 * // Basic prompt
 * prompt(editor, "Default value", {
 *   placeholder: "Enter text...",
 *   onAccept: (data) => console.log(data.value)
 * });
 *
 * // Built-in prompts
 * prompt.gotoLine(editor);
 * prompt.commands(editor);
 * prompt.modes(editor);
 * ```
 *
 * @module
 */

/**
 * @typedef {import("../editor").Editor} Editor
 */

"use strict";

var nls = require("../config").nls;
var Range = require("../range").Range;
var dom = require("../lib/dom");
var FilteredList= require("../autocomplete").FilteredList;
var AcePopup = require('../autocomplete/popup').AcePopup;
var $singleLineEditor = require('../autocomplete/popup').$singleLineEditor;
var UndoManager = require("../undomanager").UndoManager;
var Tokenizer = require("../tokenizer").Tokenizer;
var overlayPage = require("./menu_tools/overlay_page").overlayPage;
var modelist = require("./modelist");
var openPrompt;

/**
 * @typedef PromptOptions
 * @property {String} name             Prompt name.
 * @property {String} $type            Use prompt of specific type (gotoLine|commands|modes or default if empty).
 * @property {[number, number]} selection  Defines which part of the predefined value should be highlighted.
 * @property {Boolean} hasDescription  Set to true if prompt has description below input box.
 * @property {String} prompt           Description below input box.
 * @property {String} placeholder      Placeholder for value.
 * @property {Object} $rules           Specific rules for input like password or regexp.
 * @property {Boolean} ignoreFocusOut  Set to true to keep the prompt open when focus moves to another part of the editor.
 * @property {Function} getCompletions Function for defining list of options for value.
 * @property {Function} getPrefix      Function for defining current value prefix.
 * @property {Function} onAccept       Function called when Enter is pressed.
 * @property {Function} onInput        Function called when input is added to prompt input box.
 * @property {Function} onCancel       Function called when Esc|Shift-Esc is pressed.
 * @property {Function} history        Function for defining history list.
 * @property {number} maxHistoryCount
 * @property {Function} addToHistory
 */

/**
 * Prompt plugin is used for getting input from user.
 *
 * @param {Editor} editor                   Ouside editor related to this prompt. Will be blurred when prompt is open.
 * @param {String | Partial<PromptOptions>} message                  Predefined value of prompt input box.
 * @param {Partial<PromptOptions>} options                  Cusomizable options for this prompt.
 * @param {Function} [callback]               Function called after done.
 * */
function prompt(editor, message, options, callback) {
    if (typeof message == "object") {
        // @ts-ignore
        return prompt(editor, "", message, options);
    }
    if (openPrompt) {
        var lastPrompt = openPrompt;
        editor = lastPrompt.editor;
        lastPrompt.close();
        if (lastPrompt.name && lastPrompt.name == options.name)
            return;
    }
    if (options.$type)
       return prompt[options.$type](editor, callback);

    var cmdLine = $singleLineEditor();
    cmdLine.session.setUndoManager(new UndoManager());

    /**@type {any}*/
    var el = dom.buildDom(["div", {class: "ace_prompt_container" + (options.hasDescription ? " input-box-with-description" : "")}]);
    var overlay = overlayPage(editor, el, done);
    el.appendChild(cmdLine.container);

    if (editor) {
        editor.cmdLine = cmdLine;
        cmdLine.setOption("fontSize", editor.getOption("fontSize"));
    }
    if (message) {
        cmdLine.setValue(message, 1);
    }
    if (options.selection) {
        cmdLine.selection.setRange({
            start: cmdLine.session.doc.indexToPosition(options.selection[0]),
            end: cmdLine.session.doc.indexToPosition(options.selection[1])
        });
    }

    if (options.getCompletions) {
        var popup = new AcePopup();
        popup.renderer.setStyle("ace_autocomplete_inline");
        popup.container.style.display = "block";
        popup.container.style.maxWidth = "600px";
        popup.container.style.width = "100%";
        popup.container.style.marginTop = "3px";
        popup.renderer.setScrollMargin(2, 2, 0, 0);
        popup.autoSelect = false;
        popup.renderer.$maxLines = 15;
        popup.setRow(-1);
        popup.on("click", function(e) {
            var data = popup.getData(popup.getRow());
            if (!data["error"]) {
                cmdLine.setValue(data.value || data["name"] || data);
                accept();
                e.stop();
            }
        });
        el.appendChild(popup.container);
        updateCompletions();
    }

    if (options.$rules) {
        var tokenizer = new Tokenizer(options.$rules);
        cmdLine.session.bgTokenizer.setTokenizer(tokenizer);
    }

    if (options.placeholder) {
        cmdLine.setOption("placeholder", options.placeholder);
    }

    if (options.hasDescription) {
        /**@type {any}*/
        var promptTextContainer = dom.buildDom(["div", {class: "ace_prompt_text_container"}]);
        dom.buildDom(options.prompt || "Press 'Enter' to confirm or 'Escape' to cancel", promptTextContainer);
        el.appendChild(promptTextContainer);
    }

    overlay.setIgnoreFocusOut(options.ignoreFocusOut);

    function accept() {
        var val;
        if (popup && popup.getCursorPosition().row > 0) {
            val = valueFromRecentList();
        } else {
            val = cmdLine.getValue();
        }
        var curData = popup ? popup.getData(popup.getRow()) : val;
        if (curData && !curData["error"]) {
            done();
            options.onAccept && options.onAccept({
                value: val,
                item: curData
            }, cmdLine);
        }
    }

    var keys = {
        "Enter": accept,
        "Esc|Shift-Esc": function() {
            options.onCancel && options.onCancel(cmdLine.getValue(), cmdLine);
            done();
        }
    };

    if (popup) {
        Object.assign(keys, {
            "Up": function(editor) { popup.goTo("up"); valueFromRecentList();},
            "Down": function(editor) { popup.goTo("down"); valueFromRecentList();},
            "Ctrl-Up|Ctrl-Home": function(editor) { popup.goTo("start"); valueFromRecentList();},
            "Ctrl-Down|Ctrl-End": function(editor) { popup.goTo("end"); valueFromRecentList();},
            "Tab": function(editor) {
                popup.goTo("down"); valueFromRecentList();
            },
            "PageUp": function(editor) { popup.gotoPageUp(); valueFromRecentList();},
            "PageDown": function(editor) { popup.gotoPageDown(); valueFromRecentList();}
        });
    }

    cmdLine.commands.bindKeys(keys);

    function done() {
        overlay.close();
        callback && callback();
        openPrompt = null;
    }

    cmdLine.on("input", function() {
        options.onInput && options.onInput();
        updateCompletions();
    });

    function updateCompletions() {
        if (options.getCompletions) {
            var prefix;
            if (options.getPrefix) {
                prefix = options.getPrefix(cmdLine);
            }

            var completions = options.getCompletions(cmdLine);
            popup.setData(completions, prefix);
            popup.resize(true);
        }
    }

    function valueFromRecentList() {
        var current = popup.getData(popup.getRow());
        if (current && !current["error"])
            return current.value || current.caption || current;
    }

    cmdLine.resize(true);
    if (popup) {
        popup.resize(true);
    }
    cmdLine.focus();

    openPrompt = {
        close: done,
        name: options.name,
        editor: editor
    };
}

/**
 * Displays a "Go to Line" prompt for navigating to specific line and column positions with selection support.
 *
 * @param {Editor} editor - The editor instance to navigate within
 * @param {Function} [callback]
 */
prompt.gotoLine = function(editor, callback) {
    function stringifySelection(selection) {
        if (!Array.isArray(selection))
            selection = [selection];
        return selection.map(function(r) {
            var cursor = r.isBackwards ? r.start: r.end;
            var anchor = r.isBackwards ? r.end: r.start;
            var row = anchor.row;
            var s = (row + 1) + ":" + anchor.column;

            if (anchor.row == cursor.row) {
                if (anchor.column != cursor.column)
                    s += ">" + ":" + cursor.column;
            } else {
                s += ">" + (cursor.row + 1) + ":" + cursor.column;
            }
            return s;
        }).reverse().join(", ");
    }

    prompt(editor, ":" + stringifySelection(editor.selection.toJSON()), {
        name: "gotoLine",
        selection: [1, Number.MAX_VALUE],
        onAccept: function(data) {
            var value = data.value;
            var _history = prompt.gotoLine["_history"];
            if (!_history)
                prompt.gotoLine["_history"] = _history = [];
            if (_history.indexOf(value) != -1)
                _history.splice(_history.indexOf(value), 1);
            _history.unshift(value);
            if (_history.length > 20) _history.length = 20;
            
            
            var pos = editor.getCursorPosition();
            var ranges = [];
            value.replace(/^:/, "").split(/,/).map(function(str) {
                var parts = str.split(/([<>:+-]|c?\d+)|[^c\d<>:+-]+/).filter(Boolean);
                var i = 0;
                function readPosition() {
                    var c = parts[i++];
                    if (!c) return;
                    if (c[0] == "c") {
                        var index = parseInt(c.slice(1)) || 0;
                        return editor.session.doc.indexToPosition(index);
                    }
                    var row = pos.row;
                    var column = 0;
                    if (/\d/.test(c)) {
                        row = parseInt(c) - 1;
                        c = parts[i++];
                    }
                    if (c == ":") {
                        c = parts[i++];
                        if (/\d/.test(c)) {
                            column = parseInt(c) || 0;
                        }
                    }
                    return {row: row, column: column};
                }
                pos = readPosition();
                var range = Range.fromPoints(pos, pos);
                if (parts[i] == ">") {
                    i++;
                    range.end = readPosition();
                }
                else if (parts[i] == "<") {
                    i++;
                    range.start = readPosition();
                }
                ranges.unshift(range);
            });
            editor.selection.fromJSON(ranges);
            var scrollTop = editor.renderer.scrollTop;
            editor.renderer.scrollSelectionIntoView(
                editor.selection.anchor, 
                editor.selection.cursor, 
                0.5
            );
            editor.renderer.animateScrolling(scrollTop);
        },
        history: function() {
            if (!prompt.gotoLine["_history"])
                return [];
            return prompt.gotoLine["_history"];

        },
        getCompletions: function(cmdLine) {
            var value = cmdLine.getValue();
            var m = value.replace(/^:/, "").split(":");
            var row = Math.min(parseInt(m[0]) || 1, editor.session.getLength()) - 1;
            var line = editor.session.getLine(row);
            var current = value + "  " + line;
            return [current].concat(this.history());
        },
        $rules: {
            start: [{
                regex: /\d+/,
                token: "string"
            }, {
                regex: /[:,><+\-c]/,
                token: "keyword"
            }]
        }
    });
};

/**
 * Displays a searchable command palette for executing editor commands with keyboard shortcuts and history.
 *
 * @param {Editor} editor - The editor instance to execute commands on
 * @param {Function} [callback]
 */
prompt.commands = function(editor, callback) {
    function normalizeName(name) {
        return (name || "").replace(/^./, function(x) {
            return x.toUpperCase(x);
        }).replace(/[a-z][A-Z]/g, function(x) {
            return x[0] + " " + x[1].toLowerCase(x);
        });
    }
    function getEditorCommandsByName(excludeCommands) {
        var commandsByName = [];
        var commandMap = {};
        editor.keyBinding.$handlers.forEach(function(handler) {
            var platform = handler["platform"];
            var cbn = handler["byName"];
            for (var i in cbn) {
                var key = cbn[i].bindKey;
                if (typeof key !== "string") {
                    key = key && key[platform] || "";
                }
                var commands = cbn[i];
                var description = commands.description || normalizeName(commands.name);
                if (!Array.isArray(commands))
                    commands = [commands];
                commands.forEach(function(command) {
                    if (typeof command != "string")
                        command = command.name;
                    var needle = excludeCommands.find(function(el) {
                        return el === command;
                    });
                    if (!needle) {
                        if (commandMap[command]) {
                            commandMap[command].key += "|" + key;
                        } else {
                            commandMap[command] = {key: key, command: command, description: description};
                            commandsByName.push(commandMap[command]);
                        }
                    }
                });
            }
        });
        return commandsByName;
    }
    // exclude commands that can not be executed without args
    var excludeCommandsList = ["insertstring", "inserttext", "setIndentation", "paste"];
    var shortcutsArray = getEditorCommandsByName(excludeCommandsList);
    shortcutsArray = shortcutsArray.map(function(item) {
        return {value: item.description, meta: item.key, command: item.command};
    });
    prompt(editor, "",  {
        name: "commands",
        selection: [0, Number.MAX_VALUE],
        maxHistoryCount: 5,
        onAccept: function(data) {
            if (data.item) {
                var commandName = data.item.command;
                this.addToHistory(data.item);

                editor.execCommand(commandName);
            }
        },
        addToHistory: function(item) {
            var history = this.history();
            history.unshift(item);
            delete item.message;
            for (var i = 1; i < history.length; i++) {
                if (history[i]["command"] == item.command ) {
                    history.splice(i, 1);
                    break;
                }
            }
            if (this.maxHistoryCount > 0 && history.length > this.maxHistoryCount) {
                history.splice(history.length - 1, 1);
            }
            prompt.commands["history"] = history;
        },
        history: function() {
            return prompt.commands["history"] || [];
        },
        getPrefix: function(cmdLine) {
            var currentPos = cmdLine.getCursorPosition();
            var filterValue = cmdLine.getValue();
            return filterValue.substring(0, currentPos.column);
        },
        getCompletions: function(cmdLine) {
            function getFilteredCompletions(commands, prefix) {
                var resultCommands = JSON.parse(JSON.stringify(commands));

                var filtered = new FilteredList(resultCommands);
                return filtered.filterCompletions(resultCommands, prefix);
            }

            function getUniqueCommandList(commands, usedCommands) {
                if (!usedCommands || !usedCommands.length) {
                    return commands;
                }
                var excludeCommands = [];
                usedCommands.forEach(function(item) {
                    excludeCommands.push(item.command);
                });

                var resultCommands = [];

                commands.forEach(function(item) {
                    if (excludeCommands.indexOf(item.command) === -1) {
                        resultCommands.push(item);
                    }
                });

                return resultCommands;
            }

            var prefix = this.getPrefix(cmdLine);
            var recentlyUsedCommands = getFilteredCompletions(this.history(), prefix);
            var otherCommands = getUniqueCommandList(shortcutsArray, recentlyUsedCommands);
            otherCommands = getFilteredCompletions(otherCommands, prefix);

            if (recentlyUsedCommands.length && otherCommands.length) {
                recentlyUsedCommands[0].message = nls("prompt.recently-used", "Recently used");
                otherCommands[0].message = nls("prompt.other-commands", "Other commands");
            }

            var completions = recentlyUsedCommands.concat(otherCommands);
            return completions.length > 0 ? completions : [{
                value: nls("prompt.no-matching-commands", "No matching commands"),
                error: 1
            }];
        }
    });
};

/**
 * Shows an interactive prompt containing all available syntax highlighting modes
 * that can be applied to the editor session. Users can type to filter through the modes list
 * and select one to change the editor's syntax highlighting mode. The prompt includes real-time
 * filtering based on mode names and captions.
 *
 * @param {Editor} editor - The editor instance to change the language mode for
 * @param {Function} [callback]
 */

prompt.modes = function(editor, callback) {
    /**@type {any[]}*/
    var modesArray = modelist.modes;
    modesArray = modesArray.map(function(item) {
        return {value: item.caption, mode: item.name};
    });
    prompt(editor, "",  {
        name: "modes",
        selection: [0, Number.MAX_VALUE],
        onAccept: function(data) {
            if (data.item) {
                var modeName = "ace/mode/" + data.item.mode;
                editor.session.setMode(modeName);
            }
        },
        getPrefix: function(cmdLine) {
            var currentPos = cmdLine.getCursorPosition();
            var filterValue = cmdLine.getValue();
            return filterValue.substring(0, currentPos.column);
        },
        getCompletions: function(cmdLine) {
            function getFilteredCompletions(modes, prefix) {
                var resultCommands = JSON.parse(JSON.stringify(modes));

                var filtered = new FilteredList(resultCommands);
                return filtered.filterCompletions(resultCommands, prefix);
            }

            var prefix = this.getPrefix(cmdLine);
            var completions = getFilteredCompletions(modesArray, prefix);
            return completions.length > 0 ? completions : [{
                "caption": "No mode matching",
                "value": "No mode matching",
                "error": 1
            }];
        }
    });
};

dom.importCssString(`.ace_prompt_container {
    max-width: 603px;
    width: 100%;
    margin: 20px auto;
    padding: 3px;
    background: white;
    border-radius: 2px;
    box-shadow: 0px 2px 3px 0px #555;
}`, "promtp.css", false);


exports.prompt = prompt;
