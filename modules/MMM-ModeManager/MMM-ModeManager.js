/* global Module */
Module.register("MMM-ModeManager", {

    defaults: {},

    getStyles: function () { return []; },
    getHeader: function () { return ""; },

    getDom: function () {
        const wrapper = document.createElement("div");
        wrapper.style.display = "none";
        return wrapper;
    },

    start: function () {
        console.log("MMM-ModeManager: FRONTEND démarré");
        this.sendSocketNotification("START", "");
    },

    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED") {
            this.hide(0, { lockString: "modemanager" });
        }
    },

    socketNotificationReceived: function (notification, payload) {
        console.log("MMM-ModeManager: socket reçu :", notification, payload);
        if (notification === "MODE_CHANGE") {
            this.sendNotification("MODE_CHANGE", payload);
        }
    }
});