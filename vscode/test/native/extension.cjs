const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path');
exports.activate=async context=>{
 const fixture=JSON.parse(await fs.readFile(path.join(context.extensionPath,'fixture.json'),'utf8'));
 process.env.PATH=fixture.root+'/bin'+path.delimiter+process.env.PATH;
 const config=vscode.workspace.getConfiguration('manuscriptReview');
 await config.update('libraryDirectory',fixture.home,vscode.ConfigurationTarget.Global);
 await config.update('pythonPath',fixture.python,vscode.ConfigurationTarget.Global);
 await vscode.workspace.getConfiguration('editor').update('wordWrap','on',vscode.ConfigurationTarget.Global);
 globalThis.nativeReviewTest={};
 await context.globalState.update('commentAgent','codex');
 const document=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.repo+'/main.tex'));
 const editor=await vscode.window.showTextDocument(document,{preview:false});
 const actual=require(context.extensionPath+'/actual.cjs');
 actual.activate({subscriptions:context.subscriptions,globalState:context.globalState,workspaceState:context.workspaceState,
  globalStorageUri:context.globalStorageUri,extensionPath:fixture.package,
  extension:{packageJSON:JSON.parse(await fs.readFile(fixture.package+'/package.json','utf8'))}});
 return {fixture,document,editor,actual,get runtime(){return globalThis.nativeReviewTest['runtime.mjs'];},get comments(){return globalThis.nativeReviewTest['comments.mjs'];},get pdfMessages(){return globalThis.nativeReviewTest.pdfMessages||[];}};
};
