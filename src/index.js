const express = require("express");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const path = require("path");
const _ = require("lodash");
const fs = require("fs-extra");
const { exec, execSync, spawn } = require("child_process");
const request = require("request");
const { searchRecursive, deleteFolderRecursive } = require("./utils");
const SERVER_STATUS = require("./status");
const API_ROUTES = require("./api");

const GAME_CENTER_PATH = path.join(__dirname, "../../GameCenter/");
const GAME_TEXTURE_PATH = path.join(GAME_CENTER_PATH, "/assets/Texture/");
const TEMPLATE_PATH = path.join(__dirname, "../../Template/");
const DOWNLOAD_PATH = path.join(__dirname, "../../download/");

// env
require("dotenv").config();
const API_DOMAIN = process.env.API_DOMAIN;
// 開發環境 : http://gs_public_api_v2.platformdev.cc:978
// QA環境 : http://uat_gs_public_api.platformdev.cc:978
// 外部UAT : http://gs_public_api.awesomegaming.io:978/

const app = express();
app.use(fileUpload({ createParentPath: true }));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("dist"));

app.get("/api/getServerStatus", (req, res) => {
    res.send({ status: SERVER_STATUS.get() });
});

app.get("/api/getRepo", (req, res) => {
    try {
        deleteFolderRecursive(GAME_CENTER_PATH);
        execSync(
            `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
            // git clone --depth 1 --single-branch --branch BAC_QA_0.0.1_0917_1 ssh://git@10.10.10.38:10022/jenkins/baccaratV2.git
        );
        console.log("Cloning done...");
        res.send({ code: 1, desc: "cloned" });
    } catch (err) {
        res.send({ code: -1, desc: "cloning failed" });
    }
});

app.get("/api/download", (req, res) => {
    execSync(`zip -r archive *`, {
        cwd: DOWNLOAD_PATH
    });

    res.download(path.join(DOWNLOAD_PATH, "/archive.zip"));
});

app.get("/api/getAllTextures", (req, res) => {
    deleteFolderRecursive(DOWNLOAD_PATH);
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
    const traverseDir = (dir, csv) => {
        let data = [];
        fs.readdirSync(dir).forEach(file => {
            let fullPath = path.join(dir, file);
            if (fs.lstatSync(fullPath).isDirectory()) {
                data = data.concat(traverseDir(fullPath, csv));
            }
            if (
                fs.lstatSync(fullPath).isFile() &&
                file.match(/\.png$/) &&
                file.match(/^custom/)
                // !!csv[file.toLowerCase().replace(/\.png/, "")]
            ) {
                fs.copyFileSync(fullPath, path.join(DOWNLOAD_PATH, file));

                data.push({
                    path: fullPath.replace(GAME_TEXTURE_PATH, ""),
                    description:
                        csv[file.toLowerCase().replace(/\.png/, "")] || null
                });
            }
        });
        return data;
    };

    request(
        {
            method: "GET",
            uri: `${API_DOMAIN}${API_ROUTES.get_config_list}`
        },
        (err, resp, body) => {
            const { code, config = [] } = JSON.parse(body);
            if (code === 1) {
                console.log("get_config_list csv", config.length, "files");
                const csv = config.reduce((p, c) => {
                    p[c.name.toLowerCase()] = c.description;
                    return p;
                }, {});
                const data = traverseDir(GAME_TEXTURE_PATH, csv);
                console.log("get_config_list texture", data.length, "files");

                res.send(data);
            }
        }
    );
});

app.get("/api/getTexture*", (req, res) => {
    res.sendFile(path.join(GAME_TEXTURE_PATH, `/${req.params[0]}`));
});

app.post("/api/uploadBatch", async (req, res) => {
    request(
        {
            method: "POST",
            form: { token: req.body.token },
            uri: `${API_DOMAIN}${API_ROUTES.upload_start}`
        },
        (err, resp, body) => {
            console.log("upload_start", body);
            const { code, token = "" } = JSON.parse(body);
            if (code === 1) {
                const RANDOM_HASH = Math.random()
                    .toString(36)
                    .replace(/[^a-z]+/g, "")
                    .substr(0, 5);
                console.log("Uploading...", RANDOM_HASH);
                try {
                    // deleteFolderRecursive(TEMPLATE_PATH);
                    fs.mkdirSync(path.join(TEMPLATE_PATH, RANDOM_HASH), {
                        recursive: true
                    });
                    fs.copySync(
                        GAME_CENTER_PATH,
                        path.join(TEMPLATE_PATH, RANDOM_HASH)
                    );
                    if (!req.files) {
                        res.send({
                            code: -1,
                            desc: "No file uploaded"
                        });
                    } else {
                        let data = [];
                        _.forEach(_.keysIn(req.files.images), key => {
                            let image = req.files.images[key];
                            let files = searchRecursive(
                                path.join(
                                    TEMPLATE_PATH,
                                    RANDOM_HASH,
                                    "/assets/Texture/"
                                ),
                                image.name
                            );
                            files.forEach(file => {
                                image.mv(`${file}/` + image.name);
                            });
                            data.push({
                                name: image.name,
                                mimetype: image.mimetype,
                                size: image.size
                            });
                        });

                        res.send({
                            code: 1,
                            desc: "Files are uploaded",
                            data: data
                        });

                        SERVER_STATUS.change(2);
                        console.log("Finished uploading...");
                        request(
                            {
                                method: "POST",
                                form: { token: token },
                                uri: `${API_DOMAIN}${API_ROUTES.upload_done}`
                            },
                            (err, resp, body) => {
                                console.log("upload_done", body);
                            }
                        );
                        console.log("Winding up builder...");

                        setTimeout(
                            () => buildProject(RANDOM_HASH, token),
                            3000
                        );
                    }
                } catch (err) {
                    res.status(500).send(err);
                }
            } else {
                res.send(body);
            }
        }
    );
});

const buildProject = (randomHash, token) => {
    console.log("Building with cocos...");

    request(
        {
            method: "POST",
            form: { token },
            uri: `${API_DOMAIN}${API_ROUTES.package_start}`
        },
        (err, resp, body) => {
            console.log("package_start", body);
        }
    );

    exec(
        "node gameSettingBuilder.js bac",
        { cwd: path.join(TEMPLATE_PATH, randomHash) },
        (error, stdout, stderr) => {
            console.log(stdout);
            const cocosBuilder = spawn(
                "/Applications/CocosCreator3.app/Contents/MacOS/CocosCreator",
                [
                    "--path",
                    path.join(TEMPLATE_PATH, randomHash),
                    "--build",
                    "platform=web-desktop;md5Cache=false;"
                ]
            );
            cocosBuilder.stdout.on("data", data => {
                console.log("stdout:", data.toString());
            });
            cocosBuilder.stderr.on("data", data => {
                console.log("stderr:", data.toString());
            });
            cocosBuilder.on("exit", code => {
                console.log("Done building with cocos with code:", code);
                setTimeout(() => moveProject(randomHash, token), 3000);
            });

            // exec(
            //     `/Applications/CocosCreator3.app/Contents/MacOS/CocosCreator --path ${path.join(
            //         TEMPLATE_PATH,
            //         randomHash
            //     )} --build "platform=web-desktop;md5Cache=false;"`,
            //     (err, stdout, stderr) => {
            //         console.log("Done building with cocos...", stdout);
            //         // setTimeout(() => moveProject(randomHash), 3000);
            //     }
            // );
        }
    );
};

const moveProject = (randomHash, token) => {
    console.log(`Moving project to ${randomHash}`);
    execSync(`
        ssh develop@10.10.10.40 -p 9527 "mkdir Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}"
    `);
    execSync(`
        scp -P 9527 -r ${path.join(
            TEMPLATE_PATH,
            randomHash,
            "/build/web-desktop/res/raw-assets"
        )} develop@10.10.10.40:Dev_hotUpdate/web/GameCenter/ASBaccarat/res/${randomHash}
    `);
    console.log("Done moving project...");
    request(
        {
            method: "POST",
            form: {
                token,
                demo_url: `http://10.10.10.40:84/baccarat/?temp=${randomHash}`
            },
            uri: `${API_DOMAIN}${API_ROUTES.package_done}`
        },
        (err, resp, body) => {
            console.log("package_done", body);
        }
    );
    SERVER_STATUS.change(1);
};

cron.schedule("59 23 * * *", function() {
    console.log("Running a task from cron");
    // try {
    //     deleteFolderRecursive(GAME_CENTER_PATH);
    //     execSync(
    //         `git clone ssh://git@10.10.10.38:10022/jenkins/GameCenter.git ${GAME_CENTER_PATH}`
    //     );
    //     console.log("Cloning done...");
    // } catch (err) {
    //     console.log("Cloning failed...");
    // }
});

app.listen(process.env.PORT || 8080, () =>
    console.log(`Listening on port ${process.env.PORT || 8080}!`)
);
