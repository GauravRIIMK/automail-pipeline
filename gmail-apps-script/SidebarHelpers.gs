/**
 * Opens the AutoMail dashboard sidebar.
 * Wired to a custom menu item registered in Code.gs.
 */
function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('AutoMail Pipeline')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}
