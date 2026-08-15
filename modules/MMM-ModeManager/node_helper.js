const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({

	start: function () {

		console.log("MMM-ModeManager: Node Helper démarré");

		this.expressApp.post("/mode", (req, res) => {

			let body = "";

			req.on("data", chunk => {
				body += chunk;
			});

			req.on("end", () => {

				try {

					const data = JSON.parse(body);

					console.log("MMM-ModeManager: MODE =", data.mode);

					this.sendSocketNotification(
						"MODE_CHANGE",
						data.mode
					);


					res.status(200).send("OK");

				} catch (error) {

					console.error(
						"MMM-ModeManager:",
						error
					);

					res.status(400).send("Erreur");
				}
			});
		});
	}

});