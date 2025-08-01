/**
 * ## Interactive Linking Extension
 *
 * Enables clickable links and hover interactions in the editor when the Control key is pressed. Provides
 * keyboard-accelerated navigation by detecting tokens under the cursor and emitting custom events that can be handled
 * by external code to implement go-to-definition, symbol navigation, or other link-based functionality.
 *
 * **Enable:** `editor.setOption("enableLinking", true)`
 * @module
 */

var Editor = require("../editor").Editor;

require("../config").defineOptions(Editor.prototype, "editor", {
    enableLinking: {
        set: function(val) {
            if (val) {
                this.on("click", onClick);
                this.on("mousemove", onMouseMove);
            } else {
                this.off("click", onClick);
                this.off("mousemove", onMouseMove);
            }
        },
        value: false
    }
});

exports.previousLinkingHover = false;

function onMouseMove(e) {
    var editor = e.editor;
    var ctrl = e.getAccelKey();

    if (ctrl) {
        var editor = e.editor;
        var docPos = e.getDocumentPosition();
        var session = editor.session;
        var token = session.getTokenAt(docPos.row, docPos.column);

        if (exports.previousLinkingHover && exports.previousLinkingHover != token) {
            editor._emit("linkHoverOut");
        }
        editor._emit("linkHover", {position: docPos, token: token});
        exports.previousLinkingHover = token;
    } else if (exports.previousLinkingHover) {
        editor._emit("linkHoverOut");
        exports.previousLinkingHover = false;
    }
}

function onClick(e) {
    var ctrl = e.getAccelKey();
    var button = e.getButton();

    if (button == 0 && ctrl) {
        var editor = e.editor;
        var docPos = e.getDocumentPosition();
        var session = editor.session;
        var token = session.getTokenAt(docPos.row, docPos.column);

        editor._emit("linkClick", {position: docPos, token: token});
    }
}
