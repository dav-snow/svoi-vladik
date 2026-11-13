import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve('dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.geojson':'application/geo+json','.svg':'image/svg+xml'};
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(root+sep)||!types[extname(path)]){res.writeHead(404);res.end();return;}
    const body=await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)],'Content-Length':body.length,'Referrer-Policy':'strict-origin-when-cross-origin','X-Content-Type-Options':'nosniff'});res.end(body);
  }catch{res.writeHead(404);res.end();}
}).listen(5173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:5173'));
