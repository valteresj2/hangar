# A tiny GTK "Mini ERP" for the Linux driver test: invoice, amount, a password field and "Lançar" (writes a log line).
import sys
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

LOG = sys.argv[1]

win = Gtk.Window(title='Mini ERP Linux')
win.set_default_size(420, 220)
win.move(200, 150)
grid = Gtk.Grid(column_spacing=10, row_spacing=10, margin=16)
win.add(grid)
fields = {}
for row, (label, pw) in enumerate([('Fatura', False), ('Valor', False), ('Senha', True)]):
    grid.attach(Gtk.Label(label=label + ':'), 0, row, 1, 1)
    e = Gtk.Entry()
    e.set_visibility(not pw)
    e.get_accessible().set_name(label)
    grid.attach(e, 1, row, 1, 1)
    fields[label] = e
status = Gtk.Label(label='')
grid.attach(status, 0, 4, 2, 1)

def post(_b):
    with open(LOG, 'a') as f:
        f.write('fatura=%s\tvalor=%s\tsenha_ok=%s\n' % (fields['Fatura'].get_text(), fields['Valor'].get_text(),
                                                      'sim' if fields['Senha'].get_text() == 's3nh4-linux' else 'não'))
    status.set_text('Fatura %s lançada.' % fields['Fatura'].get_text())

btn = Gtk.Button(label='Lançar')
btn.connect('clicked', post)
grid.attach(btn, 1, 3, 1, 1)
win.connect('destroy', Gtk.main_quit)
win.show_all()
Gtk.main()
