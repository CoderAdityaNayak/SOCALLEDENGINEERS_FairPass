from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('about/', views.about, name='about'),
    path('org/', views.org, name='org'),
    path('book/',views.book,name='book')
]