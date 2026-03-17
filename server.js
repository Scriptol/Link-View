// Link View
// (c) 2016-2026 scriptol.com/scriptol.fr
// Free under the GNU GPL 3 License.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { exec, spawn } = require('child_process');

try {
    const localdirContent = fs.readFileSync(path.join(__dirname, 'localdir.js'), 'utf8');
    eval(localdirContent);
} catch (e) {
    console.error("Err: localdir.js : ", e.message);
}




var CHECKS=0;
var BROCOUNT=0;
var CHECKOK=0;
var broken=["Links report:"];
var checkResult = "" 
var DEBUG=false;
var website="";
var root="";
var PAGES={};


function beforeExit() {
    process.on("exit", function() {
        console.log(CHECKS + " links verified.")        
        var s = (BROCOUNT > 1 ? "s" : "")
        console.log(BROCOUNT + " broken link" + s + ".")
        console.log("Done.")
    })
}


function rewriteHTML(html, baseURL) {
  const origin = new URL(baseURL).origin;
  const wrapUrl = (url) => {
    if (!url || url.startsWith('#') || url.startsWith('data:') || url.startsWith('javascript:')) {
      return url;
    }

    try {
      const absolute = new URL(url, origin).href;
      if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
        return url; 
      }
      if (new URL(absolute).origin !== origin) {
        return `/proxy?url=${encodeURIComponent(absolute)}`;
      }
      
      return url;
    } catch (e) {
      return url; 
    }
  };

    return html
    .replace(/(src|href)=["']([^"']+)["']/g, (match, attr, url) => {
      return `${attr}="${wrapUrl(url)}"`;
    });
}


async function checkLink(link) {
    return new Promise((resolve) => {
        try {
        const urlobj = new URL(link);
        const protocol = urlobj.protocol === 'https:' ? https : http;

        const options = {
            method: 'HEAD',
            hostname: urlobj.hostname,
            path: urlobj.pathname + urlobj.search,
            port: urlobj.port || (urlobj.protocol === 'https:' ? 443 : 80),
            timeout: 2000,
            headers: { "User-Agent": "Mozilla/5.0" }
        };

        const req = protocol.request(options, (res) => {
            resolve(res.statusCode);
        });

        req.on('error', () => resolve(0));
        req.on('timeout', () => {
            req.destroy();
            resolve(0);
        });

        req.end();
        } catch (e) {
            resolve(0); // URL invalide
        }        
    });
}

async function getStatus(link) {
    CHECKS++;
    const code = await checkLink(link);
    let status = "";

    switch(code) {
        case 301: return ["Redirected", code];
        case 403: return ["Forbidden", code];
        case 404:
            BROCOUNT++;
            return ["Broken", code];
        case 200:
        case 302:
        case 500:   
            return ["OK", code];
    }
    return ["Server issue", code];
}


// Get links in the HTML content

function extractLinks(html) {
    const links = new Set();
    const regexA = /<a\s+[^>]*href="([^"]+)"/gi;
    const regexImg = /<img\s+[^>]*src="([^"]+)"/gi;
    let match;

    while ((match = regexA.exec(html)) !== null) {
        if (!match[1].startsWith("#") && 
            !match[1].startsWith("javascript:") && 
            !match[1].startsWith("mailto:")) {
            links.add(match[1]);
        }        
    }
    while ((match = regexImg.exec(html)) !== null) {
        links.add(match[1]);
    }
    return Array.from(links);
}

function openBrowser(url, pause) {
    console.log("open browser " + url + " " + pause)
  const platform = process.platform;
  let processRef;

  if (platform === "win32") {
    processRef = spawn("chrome", [url], { detached: true });
  } else if (platform === "darwin") {
    processRef = spawn("open", ["-a", "Google Chrome", url]);
  } else {
    processRef = spawn("google-chrome", [url], { detached: true });
  }
  setTimeout(() => {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", processRef.pid, "/F"]);
    } else {
      process.kill(processRef.pid, "SIGKILL");
    }
  }, pause);
}

const server = http.createServer((req, res) => {
    const baseURL = `http://${req.headers.host}`;
    const parsedUrl = new URL(req.url, baseURL);

    if (parsedUrl.pathname === '/proxy') {
        const targetUrl = parsedUrl.searchParams.get('url');
        
        if (!targetUrl || targetUrl.startsWith('data')) {
            res.writeHead(400);
            return res.end("Invalid URL");
        }

        const protocol = targetUrl.startsWith('https') ? https : http;

        protocol.get(targetUrl, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, { 
                'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
                'Access-Control-Allow-Origin': '*' 
            });
            proxyRes.pipe(res);
        }).on('error', (err) => {
            console.error("Proxy error:", err.message);
            res.writeHead(500);
            res.end();
        });
        return;
    }

    let filePath = req.url === '/' ? './interface.html' : `.${req.url}`;
    const ext = path.extname(filePath);
    const mime = {
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf'        
    };

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end("File not found");
        } else {
            res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
            res.end(content);
        }
    });
});

// WebSocket

const wss = new WebSocket.Server({ server });
let checkedList = [];
var fileContent = ""
var stopEvent = false

function waitForClientReady(ws) {
    return new Promise((resolve) => {
        ws.once("message", (msg) => {
            const data = JSON.parse(msg);
            if (data.ready === true) resolve();
        });
    });
}

function fetchUrl(targetUrl, ws) {
    const protocol = targetUrl.startsWith('https') ? https : http; 
    const options = {
        headers: {
            "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
            'Accept': '*/*',
            'Accept-Language': '*',
        }         
    };

    protocol.get(targetUrl, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let newUrl = res.headers.location;
            if (!newUrl.startsWith('http')) {
                const origin = new URL(targetUrl);
                newUrl = origin.origin + newUrl;
            }
            return fetchUrl(newUrl, ws); 
        }

        let chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const mime = res.headers["content-type"] || "text/plain";

            if (mime.includes("text/html")) {
                const rawHtml = buffer.toString("utf8");
                if (!rawHtml || rawHtml.trim().length === 0) {
                    return ws.send(JSON.stringify({ type: "error", message: "Empty HTML content" }));
                }
                const rewritten = rewriteHTML(rawHtml, targetUrl);
                ws.send(JSON.stringify({
                    type: "html",
                    data: rewritten || "<html><body>No content available</body></html>", 
                    link: targetUrl
                }));
            } 
            else if (mime.startsWith("image/")) {
                const base64Image = buffer.toString("base64");
                ws.send(JSON.stringify({
                type: "image",
                mime,
                data: `data:${mime};base64,${base64Image}`, 
                link:targetUrl
                }));
            }
            else if (mime === "application/pdf") {
                const base64Pdf = buffer.toString("base64");
                ws.send(JSON.stringify({
                    type: "pdf",
                    mime: mime,
                    data: `data:application/pdf;base64,${base64Pdf}`,
                    link: targetUrl
                    }));
            }
            else {
                ws.send(JSON.stringify({
                    type: "raw",
                    mime,
                    data: buffer.toString("utf8"),
                    link:targetUrl
                }));
            }
        });
    }).on('error', (err) => {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
    });
}


wss.on('connection', (ws) => {
    console.log("Connected");

    ws.on('message', async (msg) => {
        const data = JSON.parse(msg);

        if(data.type=== 'SCAN')  {
            var optInt = data.all
            var optView = data.view
            var pause = data.pause
            start(data.site, data.path);
            console.log("Found " + FilesArray.length + " files")
            var siteRoot = addProtocol(data.site) + "/"
            var locLength = data.path.length

            for(const filePath of FilesArray) {
                let newpage = true
                try {
                    if(!optInt && (filePath.indexOf(data.site) != "-1") ) continue
                    const html = fs.readFileSync(filePath, 'utf8');
                    if(!html) {
                        console.log("Err "+ filePath + " not read.")
                        continue;
                    }
                    const links = extractLinks(html);
                    var subDir = filePath.slice(locLength + 1)
                    let lio = subDir.lastIndexOf("/")
                    if(lio == -1) {
                        subDir = ""
                    }
                    else {
                        subDir = subDir.slice(0, lio + 1)
                    }    

                    for (var link of links) {
                        if(!hasProtocol(link)) {
                            if(link[0]=="/") {
                                link = siteRoot + link
                            }
                            else {
                                link = siteRoot + subDir + link
                            }
                        }    
  
                        let [status, code] = await getStatus(link);
                        if(DEBUG) console.log(status + " " + code + " " +link)
                        const isInternal = link.startsWith(siteRoot);
                        const toDisplay = optView && !isInternal

                        if(newpage && ((status !== "OK") || toDisplay)) {
                            newpage = false
                            ws.send(JSON.stringify({ 
                                type: 'PAGE_INFO',  
                                fileName: filePath, 
                                content : html,
                                nlinks : links.length
                            }))  
                        }
                        let skipped = false
                                
                        if (toDisplay && (status === "OK" || code===301)) {
                            const url = new URL(link).href;
                            const ext = getExtension(url)
                            if(ext == "zip" || ext =="gz" || ext == "gzip") {
                                skipped = true;
                                continue;
                            }    

                            fetchUrl(url,ws)
                   
                            await new Promise((resolve) => {
                                ws.once("message", (msg) => {
                                    const data = JSON.parse(msg);
                                    if (data.ready) resolve();
                                });
                            });
                            await new Promise(resolve => setTimeout(resolve, pause * 1000));
                        } 
                          
                        if(status != "OK" || (optView && !isInternal) || skipped)
                            ws.send(JSON.stringify({
                                type: "CHECKED",
                                link : link, 
                                code : code,
                                status: status
                            }));  
                        //} 
                    } // for
                }
                catch(e)  {
                    console.log(`error ${link} :`, e.message);                    
                } 
            } // for   
            console.log("Completed " + CHECKS +" checked, " + BROCOUNT + " broken.")
            ws.send(JSON.stringify({
                type: "COMPLETED",
                total: CHECKS,
                broken: BROCOUNT
            }));  
        } // SCAN

        if( data.type === 'STOP') {
            stopEvent = true;
        } // exit  

        if( data.type === 'RESUME') {
            stopEvent = false;
        } // exit          
        
    
        if( data.type === 'EXIT') {
            server.close(() => {
                beforeExit();
                console.log("App closed.")
                process.kill(process.pid, 'SIGINT');
            })         
        } // exit    

    }) // message
    
}) // connection

// ------------------------------------------------------
server.listen(3000, () => {
    const url = "http://localhost:3000";
    console.log("Server started on " + url);    

    switch (process.platform) {
        case "win32":
            exec('start chrome --app=http://localhost:3000');
            break
        case "darwin":
            exec('open -a "Google Chrome" http://localhost:3000')
            break
        case "linux":
            exec('google-chrome http://localhost:3000')
            break;
    }
});